const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// --- Configuration ---
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const DASHBOARD = 'https://dashboard.katabump.com';
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Telegram ---
async function sendTG(msg, imgPath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: msg, parse_mode: 'Markdown'
        });
    } catch (e) { console.error('[TG] 发送失败:', e.message); }
    if (imgPath && fs.existsSync(imgPath)) {
        exec(`curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imgPath}"`);
    }
}

// --- Stealth ---
chromium.use(stealth);

// --- Proxy ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;
if (HTTP_PROXY) {
    try {
        const u = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${u.protocol}//${u.hostname}:${u.port}`,
            username: u.username ? decodeURIComponent(u.username) : undefined,
            password: u.password ? decodeURIComponent(u.password) : undefined
        };
        console.log(`[代理] ${PROXY_CONFIG.server}`);
    } catch (e) { console.error('[代理] 格式无效'); process.exit(1); }
}

// --- Inject Script (Turnstile bypass) ---
const INJECT = `
(function() {
    if (window.self === window.top) return;
    try {
        let sx = Math.floor(Math.random()*400+800), sy = Math.floor(Math.random()*200+400);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: sx });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: sy });
    } catch(e) {}
    try {
        const orig = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const root = orig.call(this, init);
            if (root) {
                const check = () => {
                    const cb = root.querySelector('input[type="checkbox"]');
                    if (cb) {
                        const r = cb.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            window.__turnstile_data = {
                                xRatio: (r.left + r.width/2) / window.innerWidth,
                                yRatio: (r.top + r.height/2) / window.innerHeight
                            };
                            return true;
                        }
                    }
                    return false;
                };
                if (!check()) {
                    new MutationObserver(() => { if (check()) this.disconnect(); })
                        .observe(root, { childList: true, subtree: true });
                }
            }
            return root;
        };
    } catch(e) {}
})();
`;

// --- Chrome Launch ---
function checkPort(port) {
    return new Promise(resolve => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已运行'); return; }
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_user_data'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) { console.log('✅ Chrome 已启动'); return; }
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Chrome 启动失败');
}

// --- Users ---
function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const p = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(p) ? p : (p.users || []);
        }
    } catch (e) { console.error('USERS_JSON 解析错误:', e); }
    return [];
}

// --- CDP Click Turnstile ---
async function cdpClick(page) {
    for (const frame of page.frames()) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (!data) continue;
            const el = await frame.frameElement();
            const box = await el.boundingBox();
            if (!box) continue;
            const cx = box.x + box.width * data.xRatio;
            const cy = box.y + box.height * data.yRatio;
            console.log(`  >> CDP 点击: (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1
            });
            await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
            await client.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1
            });
            await client.detach();
            return true;
        } catch (e) {}
    }
    return false;
}

// --- xdotool Click Turnstile (fallback) ---
async function xdotoolClick(page) {
    try {
        // Get Turnstile iframe position
        const frames = page.frames();
        for (const frame of frames) {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (!data) continue;
            const el = await frame.frameElement();
            const box = await el.boundingBox();
            if (!box) continue;
            
            const cx = Math.round(box.x + box.width * data.xRatio);
            const cy = Math.round(box.y + box.height * data.yRatio);
            console.log('  >> xdotool 点击: (' + cx + ', ' + cy + ')');
            
            // Move mouse naturally then click
            const { execSync } = require('child_process');
            // Move in steps
            execSync('xdotool mousemove ' + cx + ' ' + cy);
            await page.waitForTimeout(200 + Math.random() * 300);
            execSync('xdotool click 1');
            console.log('  >> xdotool 点击已发送');
            return true;
        }
    } catch (e) {
        console.log('  >> xdotool 点击失败:', e.message);
    }
    return false;
}

async function waitTurnstile(page, sec = 10) {
    for (let i = 0; i < sec; i++) {
        for (const f of page.frames()) {
            if (f.url().includes('cloudflare')) {
                try {
                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 }))
                        return true;
                } catch (e) {}
            }
        }
        await page.waitForTimeout(1000);
    }
    return false;
}

// --- Main ---
(async () => {
    const users = getUsers();
    if (!users.length) { console.log('❌ 无账号'); process.exit(1); }
    console.log(`🚀 KataBump 自动续期！共 ${users.length} 个账号`);

    await launchChrome();
    let browser;
    for (let k = 0; k < 5; k++) {
        try { browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`); break; }
        catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
    if (!browser) { console.error('连接 Chrome 失败'); process.exit(1); }

    const ctx = browser.contexts()[0];
    let page = ctx.pages().length > 0 ? ctx.pages()[0] : await ctx.newPage();
    page.setDefaultTimeout(60000);
    if (PROXY_CONFIG?.username) await ctx.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    await page.addInitScript(INJECT);

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    let ok = 0, fail = 0;

    for (const user of users) {
        const safeU = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n${'='.repeat(40)}`);
        console.log(`处理: ${user.username.slice(0,3)}***@${user.username.split('@')[1] || '?'}`);

        try {
            // 登出
            if (page.url().includes('dashboard')) {
                await page.goto(`${DASHBOARD}/auth/logout`);
                await page.waitForTimeout(2000);
            }
            await page.goto(`${DASHBOARD}/auth/login`);
            await page.waitForTimeout(2000);
            if (!page.url().includes('login')) {
                await page.goto(`${DASHBOARD}/auth/logout`);
                await page.waitForTimeout(2000);
                await page.goto(`${DASHBOARD}/auth/login`);
            }

            // 填表
            console.log('填入凭据...');
            await page.getByRole('textbox', { name: 'Email' }).waitFor({ state: 'visible', timeout: 5000 });
            await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
            await page.waitForTimeout(500);

                        // Turnstile (登录) - CDP + xdotool
            console.log('  >> 登录页 Turnstile (CDP+xdotool)...');
            let tsOk = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                let clicked = false;
                for (let i = 0; i < 10; i++) {
                    if (await cdpClick(page)) { clicked = true; break; }
                    await page.waitForTimeout(1000);
                }
                if (!clicked) {
                    console.log('  >> CDP 未命中，尝试 xdotool...');
                    for (let i = 0; i < 5; i++) {
                        if (await xdotoolClick(page)) { clicked = true; break; }
                        await page.waitForTimeout(1000);
                    }
                }
                if (clicked && await waitTurnstile(page, 15)) { tsOk = true; break; }
                console.log(`  >> Turnstile 第 $` + (attempt+1) + `/3 次失败，刷新...`);
                await page.reload();
                await page.waitForTimeout(3000);
                try {
                    await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
                    await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
                } catch (e) {}
            }
            if (!tsOk) console.log('  ⚠️ Turnstile 未确认成功');

            // 点击登录
            await page.getByRole('button', { name: 'Login', exact: true }).click();
            await page.waitForTimeout(3000);

            // 检查 captcha 错误
            if (page.url().includes('error=captcha')) {
                console.log('  ⚠️ Turnstile 拦截，刷新重试...');
                await page.reload();
                await page.waitForTimeout(3000);
                try {
                    await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
                    await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
                } catch (e) {}
                for (let i = 0; i < 20; i++) {
                    if (await cdpClick(page)) break;
                    await page.waitForTimeout(1000);
                }
                await page.waitForTimeout(5000);
                await page.getByRole('button', { name: 'Login', exact: true }).click();
                await page.waitForTimeout(3000);
            }

            // 仍在登录页
            if (page.url().includes('login') && !page.url().includes('dashboard')) {
                console.log('❌ 无法通过登录页');
                const shot = path.join(photoDir, `${safeU}_login_fail.png`);
                await page.screenshot({ path: shot, fullPage: true });
                await sendTG(`❌ *KataBump 登录失败*\n用户: \`${user.username}\`\n原因: Turnstile 拦截`, shot);
                fail++; continue;
            }

            // 密码错误
            try {
                if (await page.getByText('Incorrect password or no account').isVisible({ timeout: 3000 })) {
                    console.log('❌ 账号或密码错误');
                    fail++; continue;
                }
            } catch (e) {}

            // 找服务器
            console.log('寻找服务器入口...');
            let serverFound = false;
            // 列出所有链接 (调试)
            try {
                const allLinks = await page.evaluate(() =>
                    [...document.querySelectorAll('a')].map(a => ({ t: a.textContent.trim().substring(0,30), h: a.href }))
                        .filter(l => l.t)
                );
                console.log(`  页面链接 (${allLinks.length}): ${allLinks.slice(0,10).map(l => `'${l.t}'`).join(', ')}`);
            } catch (e) {}

            for (const text of ['See', 'View', 'Manage', 'Open', 'Details']) {
                try {
                    const link = page.getByRole('link', { name: text }).first();
                    await link.waitFor({ state: 'visible', timeout: 3000 });
                    await link.click();
                    serverFound = true;
                    console.log(`✅ 找到 "${text}" 链接`);
                    break;
                } catch (e) { continue; }
            }
            if (!serverFound) {
                try {
                    const links = await page.evaluate(() =>
                        [...document.querySelectorAll('a[href*="/server/"]')].map(a => a.href)
                    );
                    if (links.length > 0) {
                        await page.goto(links[0]);
                        serverFound = true;
                        console.log(`✅ 导航到: ${links[0]}`);
                    }
                } catch (e) {}
            }
            if (!serverFound) {
                console.log('❌ 未找到服务器入口');
                fail++; continue;
            }

            await page.waitForTimeout(2000);
            console.log(`当前页面: ${page.url}`);

            // --- 续期循环 ---
            let renewSuccess = false;
            for (let att = 1; att <= 20; att++) {
                console.log(`\n[尝试 ${att}/20] Renew...`);
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}

                if (!(await renewBtn.isVisible())) {
                    // 无 Renew 按钮 → 检查是否暂不需要续期
                    const pageText = await page.innerText('body').catch(() => '');
                    const expMatch = pageText.match(/[Ee]xpir\w*.*?(\d{4}[-/]\d{2}[-/]\d{2}[\s\w:]*)/);
                    if (expMatch) {
                        console.log(`⏳ 暂不需要续期 (到期: ${expMatch[1].trim()})`);
                        const shot = path.join(photoDir, `${safeU}_no_renew.png`);
                        await page.screenshot({ path: shot, fullPage: true });
                        await sendTG(`⏳ *KataBump 暂无需续期*\n用户: \`${user.username}\`\n到期: \`${expMatch[1].trim()}\``, shot);
                        renewSuccess = true;
                    } else if (/Overview|Settings|Console/.test(pageText)) {
                        console.log('⏳ 在服务器页面，无 Renew 按钮');
                        renewSuccess = true;
                    } else {
                        console.log('未找到 Renew 按钮 (页面异常)');
                    }
                    break;
                }

                await renewBtn.click();
                const modal = page.locator('#renew-modal');
                try { await modal.waitFor({ state: 'visible', timeout: 5000 }); }
                catch (e) { continue; }

                // 晃鼠标
                try {
                    const box = await modal.boundingBox();
                    if (box) await page.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: 5 });
                } catch (e) {}

                // Turnstile (模态框)
                console.log('  >> 模态框 Turnstile...');
                let cdpOk = false;
                for (let fa = 0; fa < 30; fa++) {
                    if (await cdpClick(page)) { cdpOk = true; break; }
                    if (fa % 5 === 4) console.log(`  >> [${fa+1}/30] 等待...`);
                    await page.waitForTimeout(1000);
                }
                if (cdpOk) { await page.waitForTimeout(8000); await waitTurnstile(page, 5); }

                // 截图
                try {
                    await page.screenshot({ path: path.join(photoDir, `${safeU}_ts_${att}.png`), fullPage: true });
                } catch (e) {}

                // 点击确认
                const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                if (!(await confirmBtn.isVisible())) {
                    await page.reload(); await page.waitForTimeout(3000); continue;
                }

                await confirmBtn.click();
                console.log('  >> 点击确认...');

                // 检查结果
                let captchaErr = false, done = false;
                const t0 = Date.now();
                while (Date.now() - t0 < 3000) {
                    try {
                        if (await page.getByText('Please complete the captcha to continue').isVisible({ timeout: 200 })) {
                            console.log('  ⚠️ 验证码未通过');
                            captchaErr = true; break;
                        }
                    } catch (e) {}
                    try {
                        const nt = page.getByText("You can't renew your server yet");
                        if (await nt.isVisible({ timeout: 200 })) {
                            const txt = await nt.innerText();
                            const m = txt.match(/as of\s+(.*?)\s+\(/);
                            const nd = m ? m[1] : '未知';
                            console.log(`  ⏳ 未到时间: ${nd}`);
                            const shot = path.join(photoDir, `${safeU}_skip.png`);
                            await page.screenshot({ path: shot, fullPage: true });
                            await sendTG(`⏳ *KataBump 暂无法续期*\n用户: \`${user.username}\`\n下次: ${nd}`, shot);
                            done = true; break;
                        }
                    } catch (e) {}
                    await page.waitForTimeout(200);
                }

                if (done) { renewSuccess = true; break; }
                if (captchaErr) { await page.reload(); await page.waitForTimeout(3000); continue; }

                // 成功?
                await page.waitForTimeout(2000);
                try {
                    if (!(await modal.isVisible())) {
                        console.log('  ✅ 续期成功！');
                        const shot = path.join(photoDir, `${safeU}_success.png`);
                        await page.screenshot({ path: shot, fullPage: true });
                        await sendTG(`✅ *KataBump 续期成功*\n用户: \`${user.username}\``, shot);
                        renewSuccess = true;
                        break;
                    }
                } catch (e) {}

                console.log('  模态框仍打开，刷新重试...');
                await page.reload();
                await page.waitForTimeout(3000);
            }

            if (renewSuccess) { ok++; } else { fail++; }

        } catch (err) {
            console.error(`❌ 异常: ${err.message}`);
            fail++;
        }

        try {
            await page.screenshot({ path: path.join(photoDir, `${safeU}.png`), fullPage: true });
        } catch (e) {}
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`📊 结果: ✅ ${ok} 成功 | ❌ ${fail} 失败`);
    await sendTG(`📊 *KataBump 续期报告*\n成功: ${ok}\n失败: ${fail}\n共: ${users.length} 个账号`);
    await browser.close();
    process.exit(fail > 0 ? 1 : 0);
})();
