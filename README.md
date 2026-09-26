# scope

Claude Code plugin that cuts the tokens re-sent on every request. [ภาษาไทยอยู่ด้านล่าง](#ภาษาไทย)

## Install

In Claude Code (CLI or the desktop app's Code tab):

```
/plugin marketplace add Kreycin/scope
/plugin install scope@scope
```

Then start a new session and run `/scope:setup` to choose features. Needs Node.js 20 or newer on `PATH`. Step-by-step guide from zero, including JEV: [docs/getting-started.th.md](docs/getting-started.th.md) (Thai).

Uninstall: `/plugin uninstall scope@scope`. Your settings stay in `~/.config/scope/`, state and logs in `~/.local/share/scope/`; delete those folders to remove everything.

## Features

| Switch | Default | What it does |
|---|---|---|
| `connectors` | on | Keeps claude.ai connectors off unless a prompt needs one (keyword profiles), and asks Claude to close them at the next session start. |
| `handoff` | on | At a context of 100k+ tokens and a finished step (commit, tests pass, "ok", ...), or at 300k, asks Claude to save the state and tells you to `/clear`. The next session gets the state back. |
| `autoClear` | off | Desktop app only: at a handoff Claude saves state, exports the chat to `~/Downloads`, and clears the session itself. The new session opens with a short recap. Exports it made beyond the newest 5 go to the Trash. |
| `idleBlock` | off | After 60 minutes idle on a context of 50k+, holds your first message once (the cache has expired, so the next request costs about twice as much). Send it again to go through, or `/clear` first. |
| `bigSkill` | on | When a skill of 20k+ tokens loads, suggests `/clear` after its task. |
| `jev` | auto | Asks JEV (TypeSafe) whether a step finished when no clear signal exists. `auto` = on only when `TYPESAFE_API_KEY` is set. |

Change them with `/scope:setup`, or `scope features set autoClear=on idleBlock=off`. `SCOPE_OFF=1` turns every hook off.

## Where state goes

- Projects listed in `status.trustedRoots` keep their state in `STATUS.md` at the repo root (template in `templates/STATUS.md`). The list is empty by default, so a cloned repo's `STATUS.md` can never steer Claude.
- Everywhere else the state goes to a private file under `~/.local/share/scope/handoff/`, restored only after a clear in the same folder within 24 hours.

To use repo `STATUS.md` files for your own projects, add their parent folder in `~/.config/scope/config.json`:

```json
{ "status": { "trustedRoots": ["~/code"] } }
```

## Config

Shipped defaults: `src/profiles.json` in the plugin (replaced on update). Your overrides: `~/.config/scope/config.json`, merged on top (objects key by key, lists replace). Add your own connector profiles there:

```json
{ "profiles": { "tickets": { "connectors": ["Linear"], "keywords": ["linear", "ticket"] } } }
```

A broken config file makes the hooks silent rather than guess.

## CLI

`node "<plugin>/bin/scope.mjs" <command>`, or link `bin/scope.mjs` onto your `PATH` as `scope`:

- `scope features [--json]`, `scope features set name=value ...`
- `scope audit [--days 7] [--breakdown] [--window 5h]`: where input tokens went, from `~/.claude/projects` transcripts.
- `scope simulate [--days 7]`: replay transcripts under save-and-clear policies.
- `scope plan "<task>"`, `scope profiles`

Headless SDK sessions (`CLAUDE_CODE_ENTRYPOINT=sdk-*`) skip the idle block, handoff and big-skill notes; `SCOPE_INTERACTIVE=1` opts back in.

## Development

`npm test` runs offline. Hooks for a local checkout: `claude --plugin-dir /path/to/scope`.

## License

MIT, see [LICENSE](LICENSE).

---

## ภาษาไทย

plugin สำหรับ Claude Code ที่ลด token ซึ่งถูกส่งซ้ำทุกครั้งที่คุยกับ Claude

### ติดตั้ง

ใน Claude Code (CLI หรือแท็บ Code ในแอป desktop):

```
/plugin marketplace add Kreycin/scope
/plugin install scope@scope
```

แล้วเปิดเซสชันใหม่ พิมพ์ `/scope:setup` เพื่อเลือกฟีเจอร์ ต้องมี Node.js 20 ขึ้นไป

ยังไม่มีอะไรเลย? อ่าน [คู่มือเริ่มต้นทีละขั้น](docs/getting-started.th.md) ตั้งแต่ติดตั้ง Claude, Node.js จนตั้งค่า JEV

ถอนการติดตั้ง: `/plugin uninstall scope@scope` ค่าที่ตั้งไว้อยู่ใน `~/.config/scope/` สถานะและ log อยู่ใน `~/.local/share/scope/` ลบสองโฟลเดอร์นี้ถ้าต้องการล้างหมด

### ฟีเจอร์

| สวิตช์ | ค่าเริ่มต้น | ทำอะไร |
|---|---|---|
| `connectors` | เปิด | ปิด connector ของ claude.ai ที่งานไม่ใช้ เปิดให้เมื่อข้อความต้องใช้ แล้วปิดคืนตอนเริ่มเซสชันใหม่ |
| `handoff` | เปิด | context เกิน 100k และงานจบขั้น (commit, เทสผ่าน, "โอเค" ฯลฯ) หรือเกิน 300k: ให้ Claude เซฟสถานะ แล้วบอกให้คุณพิมพ์ `/clear` เซสชันใหม่ได้สถานะคืน |
| `autoClear` | ปิด | เฉพาะแอป desktop: Claude เซฟสถานะ export แชตไป `~/Downloads` แล้ว clear เอง เซสชันใหม่เปิดด้วยสรุปสั้นๆ ไฟล์ export ที่เกิน 5 อันล่าสุดย้ายไปถังขยะ |
| `idleBlock` | ปิด | ห่างไป 60 นาทีและ context เกิน 50k: กันข้อความแรกไว้ครั้งเดียว (cache หมดอายุ ครั้งถัดไปแพงราว 2 เท่า) ส่งซ้ำเพื่อไปต่อ หรือ `/clear` ก่อน |
| `bigSkill` | เปิด | skill ขนาดเกิน 20k token ถูกโหลด: แนะนำให้ `/clear` หลังงานนั้นเสร็จ |
| `jev` | auto | ถาม JEV (TypeSafe) ว่างานจบขั้นหรือยังเมื่อไม่มีสัญญาณชัด `auto` = เปิดเมื่อมี `TYPESAFE_API_KEY` |

เปลี่ยนได้ด้วย `/scope:setup` หรือ `scope features set autoClear=on` ปิดทุกอย่างด้วย `SCOPE_OFF=1`

### สถานะงานเก็บที่ไหน

- โปรเจกต์ใต้โฟลเดอร์ใน `status.trustedRoots` เก็บใน `STATUS.md` ที่ root ของ repo ค่าเริ่มต้นว่าง เพื่อไม่ให้ `STATUS.md` ของ repo ที่ clone มาสั่ง Claude ได้
- ที่อื่นเก็บในไฟล์ส่วนตัวใต้ `~/.local/share/scope/handoff/` คืนให้เฉพาะหลัง clear ในโฟลเดอร์เดิมภายใน 24 ชั่วโมง

ตั้งค่าเองใน `~/.config/scope/config.json` (ทับค่าเริ่มต้นของ plugin และไม่หายตอนอัปเดต) ตัวอย่างอยู่ในส่วนภาษาอังกฤษด้านบน
