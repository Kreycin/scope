// Feature switches the setup command offers, mapped to config paths in the user file.
import { readUserConfig, writeUserConfig, deepMerge } from './config.mjs';

export const FEATURES = {
  connectors: { path: ['connectors', 'enabled'], values: ['on', 'off'], th: 'ปิด connector ที่งานไม่ใช้ เปิดให้เมื่อข้อความต้องใช้', en: 'Keep claude.ai connectors off unless a prompt needs one' },
  handoff: { path: ['handoff', 'enabled'], values: ['on', 'off'], th: 'context ใหญ่และงานจบขั้น: เตือนให้เซฟสถานะแล้ว /clear', en: 'At a big context and a finished step, suggest saving state and /clear' },
  autoClear: { path: ['handoff', 'autoClear', 'enabled'], values: ['on', 'off'], th: 'แอป desktop: เซฟสถานะ export แชตไป Downloads แล้ว clear ให้อัตโนมัติ', en: 'Desktop app: save state, export the chat to Downloads, then clear automatically' },
  idleBlock: { path: ['idleBlock', 'enabled'], values: ['on', 'off'], th: 'ห่างไป 60 นาทีแล้ว context ใหญ่: กันข้อความแรกไว้ครั้งเดียวให้เลือก /clear ก่อน', en: 'After 60 min idle on a big context, hold the first prompt once so you can /clear first' },
  bigSkill: { path: ['bigSkill', 'enabled'], values: ['on', 'off'], th: 'skill ใหญ่ (>=20k tokens) โหลดเข้ามา: เตือนให้ /clear หลังงานนั้นเสร็จ', en: 'When a skill of 20k+ tokens loads, suggest /clear after its task' },
  jev: { path: ['handoff', 'jev', 'enabled'], values: ['auto', 'on', 'off'], th: 'ใช้ JEV (TypeSafe) ช่วยตัดสินว่างานจบขั้นหรือยัง; auto = เปิดเมื่อมี TYPESAFE_API_KEY', en: 'Ask JEV (TypeSafe) whether a step finished; auto = on when TYPESAFE_API_KEY is set' },
};

const toValue = (v) => (v === 'on' ? true : v === 'off' ? false : v);
const fromValue = (v) => (v === true ? 'on' : v === false ? 'off' : v);

function get(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function nest(path, value) {
  return path.reduceRight((acc, k) => ({ [k]: acc }), value);
}

// Current value of each feature in the merged (effective) config, before JEV "auto" resolves.
export function listFeatures(merged) {
  return Object.entries(FEATURES).map(([name, f]) => ({ name, value: fromValue(get(merged, f.path)), values: f.values, th: f.th, en: f.en }));
}

// changes: ["autoClear=on", "idleBlock=off"]. Writes only the user file and marks setup done.
export function setFeatures(userPath, changes) {
  let user = readUserConfig(userPath);
  for (const c of changes) {
    const [name, value] = c.split('=');
    const f = FEATURES[name];
    if (!f) throw new Error(`unknown feature: ${name} (known: ${Object.keys(FEATURES).join(', ')})`);
    if (!f.values.includes(value)) throw new Error(`${name} takes ${f.values.join('|')}`);
    user = deepMerge(user, nest(f.path, toValue(value)));
  }
  user.setupDone = true;
  writeUserConfig(userPath, user);
  return user;
}
