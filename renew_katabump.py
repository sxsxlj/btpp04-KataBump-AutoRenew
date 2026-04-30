#!/usr/bin/env python3
"""
KataBump 自动续期脚本 (基于 undetected-chromedriver)

参考: peiqzh/Auto-Renew-Katabump + liveqte/Auto-Renew-Katabump
核心: uc 绕过 Turnstile + Xvfb 有头模式 + Altcha 弹窗验证

流程:
1. uc.Chrome (HEADLESS=false + Xvfb) → 不被 Turnstile 检测
2. 填表 + ActionChains 偏移点击 Turnstile
3. 点击 See → 检查到期日 → Renew → Altcha checkbox → 提交
4. TG 通知结果
"""

import os, sys, time, logging, random, re, json, subprocess
from datetime import datetime, timezone, timedelta

import requests
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.action_chains import ActionChains
from selenium.common.exceptions import TimeoutException, WebDriverException

# ===================== 配置 =====================
HEADLESS = os.getenv('HEADLESS', 'false').lower() == 'true'
ACCOUNTS_ENV = os.getenv('ACCOUNTS', os.getenv('USERS_JSON', ''))
PROXY_SERVER = os.getenv('HTTP_PROXY', '')
TG_BOT_TOKEN = os.getenv('TG_BOT_TOKEN', os.getenv('BOT_TOKEN', ''))
TG_CHAT_ID = os.getenv('TG_CHAT_ID', os.getenv('CHAT_ID', ''))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ===================== 工具 =====================
def rand_int(a, b): return random.randint(a, b)
def sleep_ms(ms): time.sleep(ms / 1000)
def human_delay(): sleep_ms(7000 + random.random() * 5000)

def human_type(driver, selector, text):
    try:
        el = WebDriverWait(driver, 15).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, selector)))
        el.clear()
        for ch in text:
            el.send_keys(ch)
            sleep_ms(rand_int(50, 150))
        return True
    except Exception as e:
        logger.warning(f"打字失败: {e}")
        return False

def mask_email(email):
    try:
        if '@' in email:
            p, d = email.split('@', 1)
            return f"{p[0]}***@{d}" if len(p) > 2 else f"{p}***@{d}"
        return f"{email[0]}***"
    except:
        return "User"

# ===================== TG 通知 =====================
def send_tg(text, photo_path=None):
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        return
    tz = timezone(timedelta(hours=8))
    ts = datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S")
    full = f"🔄 KataBump 续期通知\n\n时间: {ts}\n\n{text}"
    try:
        if photo_path and os.path.exists(photo_path):
            requests.post(
                f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendPhoto",
                data={"chat_id": TG_CHAT_ID, "caption": full},
                files={'photo': open(photo_path, 'rb')}, timeout=20)
        else:
            requests.post(
                f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",
                data={"chat_id": TG_CHAT_ID, "text": full}, timeout=10)
    except Exception as e:
        logger.warning(f"TG 发送失败: {e}")

# ===================== 核心 =====================
class KataBumpRenew:
    def __init__(self, user, password):
        self.user = user
        self.password = password
        self.masked = mask_email(user)
        self.driver = None
        self.screenshot_path = None

    def setup_driver(self):
        opts = Options()
        if HEADLESS:
            opts.add_argument('--headless')
        opts.add_argument('--no-sandbox')
        opts.add_argument('--disable-dev-shm-usage')
        opts.add_argument('--disable-blink-features=AutomationControlled')
        opts.add_argument('--remote-debugging-port=9222')
        if PROXY_SERVER:
            opts.add_argument(f'--proxy-server={PROXY_SERVER}')

        v_env = os.getenv('CHROME_VERSION', '')
        v_main = int(v_env) if v_env.isdigit() else None
        logger.info(f"🛠️ 驱动初始化 - 版本: {v_main or '自动'}")

        for v in [v_main, None]:
            try:
                self.driver = uc.Chrome(options=opts, headless=HEADLESS,
                                        version_main=v, use_subprocess=True)
                self.driver.set_window_size(1280, 720)
                return
            except Exception as e:
                if self.driver:
                    self.driver.quit()
                    self.driver = None
                if v is None:
                    raise

    def _handle_turnstile(self, context=""):
        """Cloudflare Turnstile — ActionChains 偏移点击"""
        try:
            container = WebDriverWait(self.driver, 15).until(
                EC.presence_of_element_located((By.CLASS_NAME, "cf-turnstile")))
            size = container.size
            base_x = -(size['width'] / 2) + (size['width'] * 0.12)
            rand_x = base_x + random.uniform(-5, 5)
            rand_y = random.uniform(-5, 5)

            actions = ActionChains(self.driver)
            actions.move_to_element(container)
            actions.pause(random.uniform(0.5, 0.8))
            actions.move_to_element_with_offset(container, rand_x, rand_y)
            actions.click_and_hold()
            actions.pause(random.uniform(0.1, 0.25))
            actions.release()
            actions.perform()
            logger.info(f"🖱️ {self.masked} [{context}] Turnstile 偏移点击")

            # 轮询 token
            for _ in range(15):
                token = self.driver.execute_script(
                    'return document.querySelector("input[name=\'cf-turnstile-response\']").value;')
                if token and len(token) > 20:
                    logger.info(f"✅ {self.masked} [{context}] Turnstile 通过!")
                    sleep_ms(1500 + random.random() * 1000)
                    return True
                sleep_ms(1000)
            logger.warning(f"⚠️ {self.masked} [{context}] Turnstile 超时")
            return False
        except Exception as e:
            logger.error(f"❌ {self.masked} [{context}] Turnstile 失败: {e}")
            return False

    def _handle_altcha(self):
        """续期弹窗的 Altcha 验证 — checkbox click"""
        try:
            checkbox = WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable(
                    (By.XPATH, "//div[@class='altcha']//input[@type='checkbox' and @required]")))
            logger.info(f"✅ {self.masked} 找到 Altcha 复选框")
            checkbox.click()
            sleep_ms(8000 + random.random() * 2000)
        except TimeoutException:
            logger.warning("⚠️ 未找到 Altcha 复选框 (可能不需要)")

    def process(self):
        """主续期流程"""
        logger.info(f"🚀 登录: {self.masked}")
        self.driver.get("https://dashboard.katabump.com/auth/login")
        sleep_ms(5000 + random.random() * 2000)

        # 填表
        logger.info(f"📝 {self.masked} 填写邮箱...")
        if not human_type(self.driver, "input#email", self.user):
            raise Exception("未找到邮箱输入框")
        sleep_ms(2000 + random.random() * 1000)

        logger.info(f"🔒 {self.masked} 填写密码...")
        if not human_type(self.driver, "input#password", self.password):
            raise Exception("未找到密码输入框")
        sleep_ms(2000 + random.random() * 1000)

        # Turnstile
        self._handle_turnstile("Login")

        # 登录
        logger.info(f"📤 {self.masked} 提交登录...")
        self.driver.find_element(By.CSS_SELECTOR, 'button[type="submit"]').click()
        human_delay()

        # 检查是否还在登录页
        if "login" in self.driver.current_url:
            raise Exception("登录失败 — 仍在登录页")

        # 进入服务器详情
        logger.info(f"🎯 {self.masked} 进入服务器页...")
        manage_btn = WebDriverWait(self.driver, 30).until(
            EC.element_to_be_clickable((By.XPATH, "//a[contains(text(), 'See')]")))
        self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", manage_btn)
        sleep_ms(1000 + random.random() * 1000)
        self.driver.execute_script("arguments[0].click();", manage_btn)
        human_delay()

        # 检查到期日
        logger.info(f"📅 {self.masked} 检查到期日...")
        try:
            expiry_el = WebDriverWait(self.driver, 15).until(
                EC.presence_of_element_located(
                    (By.XPATH, "//div[contains(text(), 'Expiry')]/following-sibling::div")))
            expiry_text = expiry_el.text.strip()
            logger.info(f"⌛ {self.masked} 到期: {expiry_text}")

            tz_hkt = timezone(timedelta(hours=8))
            today = datetime.now(tz_hkt).date()
            expiry_date = None
            for fmt in ["%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y"]:
                try:
                    expiry_date = datetime.strptime(expiry_text, fmt).date()
                    break
                except ValueError:
                    continue

            if expiry_date:
                days_diff = (expiry_date - today).days
                if days_diff > 1:
                    notice = f"⏰ {self.masked}\n📅 未到续期日: {expiry_text}\n🔄 剩余 {days_diff} 天"
                    logger.info(f"ℹ️ {notice}")
                    return True, notice
                elif days_diff < 0:
                    notice = f"⚠️ {self.masked}\n📅 已过期 {abs(days_diff)} 天: {expiry_text}\n⚠️ 可能已被删除!"
                    logger.warning(notice)
                    return False, notice
        except Exception as e:
            logger.warning(f"⚠️ 日期检查异常: {e}，继续续期")

        # 点击 Renew
        logger.info(f"🔄 {self.masked} 续期流程...")
        try:
            renew_btn = WebDriverWait(self.driver, 15).until(
                EC.element_to_be_clickable((By.XPATH, "//button[contains(text(), 'Renew')]")))
            self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", renew_btn)
            self.driver.execute_script("arguments[0].click();", renew_btn)
            logger.info(f"📑 {self.masked} 打开 Renew 弹窗")
        except Exception as e:
            raise Exception(f"无法打开 Renew 弹窗: {e}")

        sleep_ms(2000 + random.random() * 1000)

        # Altcha
        self._handle_altcha()

        # 最终 Renew
        try:
            confirm = WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable(
                    (By.XPATH, "//div[@id='renew-modal']//button[@type='submit' and contains(text(), 'Renew')]")))
            self.driver.execute_script("arguments[0].click();", confirm)
        except Exception as e:
            raise Exception(f"弹窗提交失败: {e}")

        sleep_ms(7000 + random.random() * 2000)

        # 结果核验
        try:
            alerts = self.driver.find_elements(By.CSS_SELECTOR, ".alert-danger")
            if alerts and alerts[0].is_displayed():
                msg = alerts[0].text.strip().replace('×', '')
                return False, f"⚠️ {self.masked}\n续期失败: {msg}"

            final_el = self.driver.find_element(
                By.XPATH, "//div[contains(text(), 'Expiry')]/following-sibling::div")
            final = final_el.text.strip()
            logger.info(f"✅ {self.masked} 续期后到期: {final}")
            if final and final != expiry_text:
                return True, f"✅ {self.masked}\n🎉 续期成功!\n📅 新到期: {final}"
            else:
                return False, f"⚠️ {self.masked}\n时间未更新 ({final})"
        except Exception as e:
            return False, f"❌ {self.masked}\n验证结果异常: {e}"

    def run(self):
        max_retries = 3
        last_error = ""
        for attempt in range(max_retries):
            try:
                if not self.driver:
                    self.setup_driver()
                if attempt > 0:
                    logger.info(f"🔄 {self.masked} 第 {attempt+1} 次尝试...")
                    self.driver.refresh()
                    sleep_ms(5000 + random.random() * 3000)
                success, msg = self.process()
                if success:
                    return True, msg
                last_error = msg
                if "续期失败" in msg:
                    break
            except Exception as e:
                last_error = str(e)[:80]
                logger.error(f"❌ {self.masked} 第 {attempt+1} 次: {e}")
                if attempt < max_retries - 1:
                    sleep_ms(5000 + random.random() * 5000)

        self.screenshot_path = f"error-{self.user.split('@')[0]}.png"
        if self.driver:
            self.driver.save_screenshot(self.screenshot_path)
        return False, f"❌ {self.masked}\n{max_retries} 次尝试均失败\n{last_error}"


# ===================== 多账号 =====================
def load_accounts():
    """解析账号: 格式 user:pass,user:pass 或 JSON"""
    accounts = []
    if not ACCOUNTS_ENV:
        return accounts

    # 尝试 JSON 格式
    try:
        users = json.loads(ACCOUNTS_ENV)
        if isinstance(users, list):
            for u in users:
                accounts.append({
                    'user': u.get('email', u.get('username', u.get('user', ''))),
                    'pass': u.get('password', u.get('pass', ''))
                })
            return accounts
    except:
        pass

    # user:pass,user:pass 格式
    for a in re.split(r'[,;\n]', ACCOUNTS_ENV):
        a = a.strip()
        if ':' in a:
            u, p = a.split(':', 1)
            accounts.append({'user': u.strip(), 'pass': p.strip()})

    return accounts


def main():
    logger.info("=" * 50)
    logger.info("🚀 KataBump 自动续期启动！")
    logger.info("=" * 50)

    accounts = load_accounts()
    if not accounts:
        logger.error("❌ 未配置账号")
        send_tg("❌ KataBump 续期失败\n未配置账号")
        sys.exit(1)

    logger.info(f"📋 共 {len(accounts)} 个账号")
    results = []
    success_count = 0

    for i, acc in enumerate(accounts):
        logger.info(f"\n{'='*30}\n📋 第 {i+1}/{len(accounts)} 个账号")
        bot = KataBumpRenew(acc['user'], acc['pass'])
        success, msg = bot.run()
        results.append({'msg': msg, 'ok': success})
        if success:
            success_count += 1

        if bot.driver:
            try:
                bot.driver.quit()
            except:
                pass
            bot.driver = None

        if i < len(accounts) - 1:
            wait = 10000 + random.random() * 5000
            logger.info(f"⏳ 等待 {wait/1000:.0f}s...")
            sleep_ms(wait)

    # 汇总
    summary = f"📊 续期汇总: {success_count}/{len(accounts)} 成功\n\n"
    summary += "\n\n".join([r['msg'] for r in results])
    logger.info(summary)
    send_tg(summary)

    sys.exit(0 if success_count == len(accounts) else 1)


if __name__ == "__main__":
    main()
