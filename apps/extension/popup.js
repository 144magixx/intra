import { SERVICES, permissionOriginsFor } from './bridge.js';
const status = document.querySelector('#status');
const profile = document.querySelector('#profile');
const services = document.querySelector('#services');
for (const service of SERVICES) {
  const label = document.createElement('label');
  const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'service'; input.value = service.id;
  label.append(input, document.createTextNode(service.label)); services.append(label);
}
async function update() {
  const result = await chrome.runtime.sendMessage({ action: 'status' });
  if (result?.ok) { status.textContent = result.result.state; profile.textContent = result.result.profileId ?? '尚未生成'; }
}
document.querySelector('#pairing').addEventListener('submit', async event => {
  event.preventDefault();
  if (!document.querySelector('#confirmed').checked) return;
  const selected = [...document.querySelectorAll('input[name="service"]:checked')].map(input => input.value);
  if (document.querySelector('#custom-enabled').checked) selected.push('domain:' + document.querySelector('#custom-domain').value.trim().toLowerCase());
  let origins;
  try { origins = permissionOriginsFor(selected); }
  catch { status.textContent = '请选择授权范围；自定义项只接受根域或选定域名（如 example.com、api.example.com 或 localhost），不接受 URL、IP 或通配符。'; return; }
  const submit = document.querySelector('#connect');
  submit.disabled = true;
  try {
    // Permission prompt is initiated inside this explicit user gesture, including all-sites opt-in.
    const granted = await chrome.permissions.request({ origins });
    if (!granted) { status.textContent = '未获得所选网站的 Cookie 权限；未发起连接。'; return; }
    status.textContent = '正在连接本机桥接程序…';
    const result = await chrome.runtime.sendMessage({ action: 'confirm', services: selected });
    if (!result?.ok) { status.textContent = '连接失败：' + (result?.code ?? 'BRIDGE_UNAVAILABLE'); return; }
    await update();
  } catch { status.textContent = '连接失败；请检查扩展 ID 与本机宿主配置。'; }
  finally { submit.disabled = false; }
});
document.querySelector('#disconnect').addEventListener('click', async () => { await chrome.runtime.sendMessage({ action: 'disconnect' }); await update(); });
document.querySelector('#reset').addEventListener('click', async () => { await chrome.runtime.sendMessage({ action: 'reset' }); document.querySelector('#confirmed').checked = false; await update(); });
void update();
