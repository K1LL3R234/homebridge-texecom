# Review of homebridge-texecom-full

**For:** Chris Posthumus, maintainer of `homebridge-texecom-full`
**From:** [metaljay/homebridge-texecom](https://github.com/metaljay/homebridge-texecom), prepared with Claude Code
**Reviewed:** release `4.4.0` (same code as `4.4.0-beta.1`). Line numbers refer to its `index.js`.

Everything here was tested on a real **Premier Elite 24 (firmware V6.05.03)** with Homebridge 2.4 on a Raspberry Pi. The panel has a SmartCom on Com Port 1 and a Crestron port (Com Port 3) bridged to the network by an ESP8266 serial server, so both protocols could be watched side by side. Items marked *Reproduced* were also run against 4.4.0 with a fake panel ([`tools/fake-panel.js`](https://github.com/metaljay/homebridge-texecom/blob/master/tools/fake-panel.js)), so you can repeat them.

## Contents

1. [Summary](#1-summary)
2. [Bugs in 4.4.0](#2-bugs-in-440)
3. [How the panel behaves](#3-how-the-panel-behaves)
4. [What the fork adds, and why](#4-what-the-fork-adds-and-why)
5. [Suggested route](#5-suggested-route)
6. [Testing done](#6-testing-done)
7. [Other projects and credits](#7-other-projects-and-credits)
8. [Later findings (October 2026)](#8-later-findings-october-2026)

---

## 1. Summary

### Most important findings

| # | Problem in 4.4.0 | Effect | Fix |
|---|---|---|---|
| 1 | Each TCP packet is parsed as one message ([2.1](#21-messages-lost-when-a-tcp-packet-holds-more-than-one)) | Keypad disarms lost (2 of 3 in a test), leading to **6 false "Triggered" alarms in 2 minutes** | Split the stream into lines |
| 2 | Alarms inferred from zone activity ([2.2](#22-zone-inferred-alarms-misfire-on-every-normal-entry)) | False alarm on every normal entry through the entry route | Use the panel's own alarm message (`"L`) |
| 3 | UDL login never logged out ([2.3](#23-every-command-from-homekit-blacks-out-the-panel-for-60-s)) | Every arm/disarm from HomeKit silences **all** panel events for ~60 s; a real alarm reached HomeKit 65 s late | Binary logout `03 48 B4` (cuts it to ~30 s) |
| 4 | 2 s command timeout; commands from different sources interleave ([2.4](#24-commands-interleave-and-the-timeout-is-too-short)) | Duplicate logins on every arm; `OK`s credited to the wrong command | A command queue and an 8 s login timeout |
| 5 | Areas reset to Disarmed on restart ([2.5](#25-areas-show-disarmed-after-every-restart)) | Wrong state, possibly for hours | Persist the state, and ask the panel (`ASTATUS`) on connect |
| 6 | Clock sync uses the machine's time zone ([2.12](#212-clock-sync-sets-the-wrong-time-when-homebridge-runs-on-utc)) | Homebridge in Docker runs on UTC, so in summer the panel is set an hour wrong | A configurable time zone; never shift by whole hours without one |
| 7 | `string` dependency ([2.10](#210-dependencies)) | High-severity advisory, no fix available | Remove it |

### What the fork adds

- **Texecom Connect support** ([4.1](#41-texecom-connect-support)): works with a SmartCom left in its normal mode, which is how most users own their hardware. Zones and areas are found automatically, arm modes are exact, and there's no blackout after HomeKit commands.
- **Crestron improvements** ([4.2](#42-crestron-improvements)): the exact part arm for Night/Home, a regular status check that catches missed events and dead links, and fixes for problems found on the real panel.
- **Tamper and fault status on the alarm** ([3.3](#33-texecom-connect), [3.4](#34-homekit)): the panel lid, detector tampers and a mains failure show as *Tampered* / *Fault* in the Home app; mode switches no longer flash *Disarmed*.
- **Choice of arm buttons in the Home app** ([4.3](#43-choosing-the-home-app-arm-buttons)), and a **settings page and README rewritten for end users** ([4.4](#44-settings-page-and-readme)).

**Suggested route:** small patches against your code for section 2, keeping your accessory identities; Connect as a self-contained addition. See [section 5](#5-suggested-route).

---

## 2. Bugs in 4.4.0

Most serious first.

### 2.1 Messages lost when a TCP packet holds more than one

*Reproduced, and confirmed on the real panel.*

**What happens.** `setupConnection()` (lines 349–354) passes each TCP `data` chunk to `processData()`, which parses only its start. TCP has no message boundaries, and the panel often sends events close together, so one chunk can hold several lines. Every line after the first is dropped. A chunk such as `"Z0071\r\nOK\r\n` also fails the `trim() === 'OK'` check, so the command times out and is resent. Serial users aren't affected: that path already uses `ReadlineParser`.

**Evidence.** In a minute of walking past sensors, 3 of 23 chunks held more than one message, losing 5 zone events. In a keypad test, "code entered" and "disarmed" (`"U0030` + `"D0013`) arrived together, and **2 of 3 disarms were lost**. The plugin still believed the area was armed, so every movement afterwards raised `Area 001 manual triggered`: **6 false alarms in 2 minutes**, with HomeKit left on Triggered. The session, with its original chunking, is in [`test/fixtures/real-session-2026-10-06.json`](https://github.com/metaljay/homebridge-texecom/blob/master/test/fixtures/real-session-2026-10-06.json), and [`tools/replay-panel.js`](https://github.com/metaljay/homebridge-texecom/blob/master/tools/replay-panel.js) replays it to any build:

| | 4.4.0 | Fork |
|---|---|---|
| Keypad disarms seen | 1 of 3 | 3 of 3 |
| False "Triggered" | 6 | 0 |
| Final HomeKit state | **Triggered** (panel disarmed) | Disarmed |

**Fix.** Run the socket through the same `ReadlineParser` as the serial path (`serialport` v12 exports it, so `@serialport/parser-readline` can go):

```js
const { ReadlineParser } = require('serialport');
const connection = net.createConnection(platform.ip_port, platform.ip_address);
connection.setNoDelay(true);
connection.setKeepAlive(true, 30000);
const lines = connection.pipe(new ReadlineParser({ delimiter: '\n' }));
connection.on('data', (data) => responseEmitter.emit('raw', data));   // clock reader
lines.on('data', (line) => { responseEmitter.emit('data', line); processData(line); });
```

After a UDL session the stream also carries binary frames with no line ending (see [2.3](#23-every-command-from-homekit-blacks-out-the-panel-for-60-s)). Drop any valid frame (`[len][type]…[checksum]`, byte sum `& 0xFF == 0xFF`) before splitting lines, or the next message is lost.

### 2.2 Zone-inferred alarms misfire on every normal entry

*Confirmed on the real panel.*

**What happens.** When a zone in an away-armed area goes active, the plugin marks the area Triggered. But walking in through the entry route is exactly that: a zone going active while armed. The panel starts the entry delay (`"E0010`) and you disarm. Only the panel knows which zones are entry routes, and it reports real alarms itself (`"L0010`), correctly. In the test, the entry zone gave `"E`, and walking on into an interior zone (immediate) gave `"L`.

**Fix.** Use `"L` for Triggered. Make zone inference opt-in for panels that don't send `L`, and ignore activity between `"E` and the following `"D`/`"L`. The fork does both (`trigger_from_zones`, off by default).

### 2.3 Every command from HomeKit blacks out the panel for ~60 s

*Confirmed on the real panel, with Texecom Connect (via the SmartCom) as an independent reference feed.*

**What happens.** Each command starts with `\W<udl>/`, which switches the Crestron port into a Wintex/UDL session. While that session is open the port sends **nothing**: no zone changes, no arm events, no alarms. Everything is held and released in one burst when the session times out, about 60 s after the last command. Nothing is lost, but in one test a **real alarm reached HomeKit 65 s late** and all motion sensors were frozen for 2½ minutes. The clock sync logs in too, so each sync causes the same blackout.

**Measured:**

| | Feed silent for |
|---|---|
| No logout (4.4.0) | ~60 s after the last command |
| Binary Wintex logout `03 48 B4` (answered `03 06 F6`) | ~30 s after the logout; a fixed panel timer that polling doesn't shorten |
| `\H/` (TexecomManager's logout) | Answered `ERROR` on this firmware; no effect |
| UDL session on a *different* port (e.g. Wintex via the SmartCom) | Not silent: the Crestron feed stays live |

**Fix.** Send `03 48 B4` straight after each command sequence. Before parsing lines, drop the binary frames the session sends (the ACK arrives glued to the next text line). In the plugin, on the real panel, this cut HomeKit's blind spot from ~68 s to ~39 s per command, with every held message processed. Also avoid unnecessary logins: `LSTATUS` shows the panel clock without one, so the clock sync only needs to log in when it actually corrects the time. Removing the blind spot entirely needs a path without a UDL session, which is what Texecom Connect gives ([4.1](#41-texecom-connect-support)).

### 2.4 Commands interleave, and the timeout is too short

*Reproduced; timing confirmed on the real panel.*

**What happens.** `areaTargetSecurityStateSet()` (line 842) and `_syncPanelClock()` (line 466) call `writeCommandAndWaitForOK` independently, and any waiting call accepts the first `OK`. Two arms at once (a scene, or a combined area plus a member) send `W…, W…, A…, A…`, and each result can be credited to the other. The panel also took **3–6 s** to answer a login, so the 2 s timer resends it every time. On this panel the login often isn't answered with `OK` at all, although the session opens.

**Fix.** Run each "login + command" sequence as one unit on a promise chain, and allow ~8 s for the login:

```js
let commandChain = Promise.resolve();
function exclusive(task) {
    const run = commandChain.then(task);
    commandChain = run.catch(() => {});
    return run;
}
exclusive(() => writeCommandAndWaitForOK(conn, `W${platform.udl}`)
    .then(() => writeCommandAndWaitForOK(conn, command)));
```

Don't treat a missing `OK` to the login as failure on its own; the command that follows tells you whether the session opened.

### 2.5 Areas show Disarmed after every restart

**What happens.** `setupServices()` (line 760) sets every area to Disarmed on start. If Homebridge restarts while the house is armed, HomeKit shows Disarmed until the next panel event, and "when disarmed" automations can fire.

**Fix.** Keep the last state in `hapAccessory.context` (saved in Homebridge's accessory cache), and send `ASTATUS` on connect: the panel answers `"YN` (one letter per area, Y = armed) without a login.

### 2.6 Errors aren't logged unless debug is on

`util/logutil.js`: `error()` only prints when debug is on, so connection errors and rejected commands are invisible. The constructor's `this.log = log` also replaces the class's own `log()`, and `debug()` writes with `console.log`, outside Homebridge's logger. **Fix:** a thin wrapper around the Homebridge logger, with the plugin's `debug` option promoting debug lines to info.

### 2.7 An area without `area_type` becomes a motion sensor

*Reproduced.* Line 625: `config["zone_type"] || config["area_type"] || "motion"`. The schema doesn't require `area_type`, and the README says it defaults to `securitysystem`. **Fix:** decide by kind: `this.kind === "area" ? "securitysystem" : (config["zone_type"] || "motion")`.

### 2.8 Connection resilience

- **Serial never reconnects** if the adapter disconnects or is missing at boot.
- **No TCP keep-alive**, so a silently dropped connection isn't noticed: `setKeepAlive(true, 30000)`.
- **No `shutdown` handler** to close the socket and clear timers.
- **A live TCP link doesn't prove the panel is answering.** A serial-to-network adapter can stay connected after its serial side fails. A periodic `ASTATUS` (the fork uses 60 s) catches that, and also corrects HomeKit after any missed event.

### 2.9 Dwell timers can stack

Lines 790–791 start a new dwell timer without clearing the previous one, so a zone toggling quickly can be marked clear while active. **Fix:** `clearTimeout` before starting a new one.

### 2.10 Dependencies

| Package | Issue | Suggestion |
|---|---|---|
| `string` | High-severity advisory with no fix ([GHSA-g36h-6r4f-3mqp](https://github.com/advisories/GHSA-g36h-6r4f-3mqp)); unbounded range `>=3.3.3` | Replace with `startsWith` / `slice` |
| `zpad` | Unmaintained | `String(n).padStart(3, '0')` |
| `debug` | Imported, never used | Remove |
| `@serialport/parser-readline` | `serialport` v12 exports `ReadlineParser` | Remove |
| `engines.node` `>=18.20.4` | Node 18 is end-of-life | `^20.18.0 \|\| ^22.10.0 \|\| ^24.0.0` |

### 2.11 Settings page

- **`udl` is an integer**, so `0123` is saved as `123` and the login fails. Make it a string (`"pattern": "^[0-9]{4,8}$"`) and use `String(config.udl)` so existing configs still work.
- **Numbers with both a minimum and a maximum render as sliders** in the Homebridge UI, so `time_sync_interval` (0–744) is a slider with no visible value. Drop the maximum, or set the layout type to `number`.
- **`headerDisplay` says "Official Texecom Homebridge plugin"**, but Texecom doesn't publish it.

### 2.12 Clock sync sets the wrong time when Homebridge runs on UTC

*Confirmed on the real panel (in the fork's Connect clock check, which worked the same way; fixed there).*

**What happens.** The clock sync compares the panel with `new Date()` in the machine's local time (lines 1107–1123) and sets the panel to it. The Homebridge Docker image runs on **UTC** unless `TZ` is set, while the panel shows local time. In UK summer time, the sync found the panel "3558 s ahead" and set it an hour back.

**Fix.** Add a `time_zone` setting (e.g. `Europe/London`) and compute the panel's wall-clock time in that zone (`Intl.DateTimeFormat` with `timeZone`). Without one, never apply a difference of about a whole number of hours: log a warning instead. The fork does both.

### 2.13 Smaller items

- **Messages not recognised:** the panel also sends `"U` (user code entered), `"X` (exit delay started), `"E` (entry delay) and `"L` (alarm); see [3.1](#31-crestron-messages). `"X` can drive the Home app's "Arming…".
- **User numbers:** this panel reports HomeKit arms as **user 29** and remote disarms as **user 0**. The `app_users` / `remote_users` defaults (25, 254) don't match, which supports keeping them configurable.
- `onSet` rejects with a plain `Error`; `throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)` is the intended way.
- No `try/catch` around `processData`, so one odd message can crash Homebridge.
- Manufacturer shows as "Homebridge"; "Texecom" is more accurate.

---

## 3. How the panel behaves

Confirmed on the V6.05.03 panel unless stated.

Further detail, kept up to date on the same panel: [ha-texecom's protocol notes](https://github.com/metaljay/ha-texecom/blob/main/docs/development/protocol.md).

### 3.1 Crestron messages

| Message | Meaning |
|---|---|
| `"Z` + zone + `0` / `1` / `2` | Zone secure / active / tamper (`2` per TexecomManager) |
| `"U` + user | Code entered at a keypad |
| `"X` + area | Exit delay started |
| `"E` + area | Entry delay started |
| `"A` + area + user / `"D` + area + user | Armed / disarmed (user number is variable width) |
| `"L` + area | Alarm |
| `ASTATUS` → `"NN` | One letter per area, Y = armed. **No login needed** |
| `LSTATUS` → `"      HOME      08:11.42 Wed 07` | The keypad screen, including the clock; shows `* PART ARMED *` while part-armed. **No login needed** |

The panel doesn't say whether an arm was full or part: `LSTATUS` can tell, but not which part arm.

### 3.2 The UDL session on the Crestron port

- `\W<udl>/` opens a **binary Wintex/UDL session** (frames `[len][cmd][payload][checksum]`, byte sum `0xFF`; ACK `03 06 F6`, NAK `03 0F ED`). Text queries sent during it are answered with `03 0F ED`.
- The login is often **not** answered with `OK`, but the session opens. When it isn't, text commands that follow may be answered `ERROR` while binary ones work.
- **Binary commands work inside that session** (from [ricol99/casa](https://github.com/ricol99/casa) and [shuckc/pytexalarm](https://github.com/shuckc/pytexalarm); part arm and disarm confirmed here):

| Command | Frame (area 1) |
|---|---|
| Full arm | `04 41 00 BA` |
| Part arm *n* | `05 53 00 0n cs` (e.g. Part Arm 1: `05 53 00 01 A6`) |
| Disarm | `04 44 00 B7` |
| Logout | `03 48 B4` |

  The Crestron `\Y` command only ever reaches Part Arm 1; `S 00 0n` reaches 1, 2 or 3.
- **Keypad emulation (`KEY<digit>`) is ignored** on this firmware, with CR LF, LF or no line ending.
- **Memory addresses are firmware-specific.** The status addresses pytexalarm and casa read on V4.02 (clock `0x003069`, area state `0x0017B6`…) return zeros on V6.05.03, so a plugin shouldn't read state by address.
- An ACK isn't proof a command was carried out; take the result from the events and `ASTATUS` that follow.
- The binary `S` part-arm frame has only been confirmed for area 1; other areas are untested. `ASTATUS` doesn't show an exit delay (the area reads `N` until it has armed) or the end of an alarm.

### 3.3 Texecom Connect

- **When an alarm is reported, the SmartCom drops the Connect session** to send its own report (the Texecom app's push still arrives), then turns logins away for **about 2 minutes** (2 min 8 s, twice). On this panel the drop came about 1.5 s **after the disarm** that followed the alarm, just after the alarm's log entries were marked *communicated*, not when the alarm started. Why it waits, and whether that depends on how the panel reports alarms, is unknown. The session ends with `+++` (modem commands such as `ATH0`/`ATZ` can also appear) or a plain close. Keep showing the last state (Triggered) meanwhile, then reconnect and re-read. A dedicated ComIP stayed connected through an alarm (another project).
- The panel **never reports an alarm ending**, and an arm that fails in the exit delay sends no area event. Re-read the area flags periodically; the fork does it every 30 s, which also keeps the session alive (it drops after ~60 s idle).
- State reads can be answered with a **1-byte NAK** just after a burst of events. Treat it as "try again", never as data (as data, `0x15` reads as "zone 1 active" or "area in alarm").
- **Area states 6, 7 and 8** arrive straight after *part armed* (4) for Part Arm 1, 2 and 3 (5 + the part arm; 8 seen after a keypad Part Arm 3, 14 October 2026). They aren't in the published lists, and a V5.02.01 panel didn't send them, so take the part arm from logs 78–80 / 204–209 or a flag re-read. A flag re-read straight after a part arm can still show the **exit flag** (3.5).
- Bulk area-flag reads work here (72 bytes); some older firmware refuses them, so fall back to one flag at a time.
- Wintex can connect through the same SmartCom while a Connect client is connected. But reading zone details while Wintex was connected ended the Connect session, and logins were turned away until Wintex disconnected (status reads were fine): see 3.5.
- A SmartCom **refuses a new session for anything from about 4 to 70 s** after the last one closed (allow 75 s before calling it a failure), and for about 2 minutes after the drop at alarm time; meanwhile a login gets a closed socket, 80-byte replies that aren't frames, or frames with bad CRCs. Keep retrying; don't treat it as a wrong UDL.
- **Switching arm mode** (disarm, then arm) produces an area "disarmed" event **0.3 s** before the new exit delay. Passed straight to HomeKit, that shows (and may notify) Disarmed in between.
- **Zone alarms are logged twice**: once when they happen and once when reported (`communicated` set). Sometimes only the second arrives, after the disarm; the zone's state byte has its *alarmed* bit (0x10) set at once, which is the quicker way to name the zone.
- **ARM_FAILED (log type 85) carries the zone** that stopped the arm in `parameter`, one log per active zone (zones that see you at the end of the exit time; the panel sounds its "fail to set" warning).
- **Tampers that aren't zones** are log events with group 11 (tamper) and 12 (restored): type **60** *Panel Box Tamper* (the lid, the keypad shows "Panel Lid Tamper") and **62** *Auxiliary Tamper*. On this install every detector's tamper is on the shared auxiliary circuit, so the panel can't say which detector was opened, and zone tamper states never change. Names for all log types are in texecom-connect. **The panel doesn't always log them**: see 3.5 for a fallback on area flag 44.
- **Mains failure**: *AC Fail* (type 47, group 9) arrives at once, but the restore is **logged late, or not at all**: one day, two *AC Fail* entries were followed by a single *Mains AC Restore* about 4 minutes after the second; other times nothing came within 14 minutes. The power reading (command 25) shows it: on battery both currents read **0** and the voltage falls (13.0 → 12.2 V in 2 minutes); on mains ~300 mA at ~13.6 V. Reading it every keep-alive gives the restore within 30 s, and the right answer after a restart.
- **A total power loss resets the panel clock** (to 31 Oct 2023 on V6.05.03), so clock sync matters on reconnect, not only daily.
- The keypad text (command 13) shows alerts, e.g. "System Alerts!" or "Panel Lid Tamper", with the clock on the second line.

### 3.4 HomeKit

- HomeKit gives up on a set request after about **9 s**, so answer `onSet` quickly and apply the outcome when the panel confirms.
- iOS caches an alarm's `validValues` (the arm buttons) for an accessory it already knows; a change only shows on a new accessory.
- The security system service has optional **StatusTampered** and **StatusFault** characteristics; the fork sets them from the panel's tampers and faults (including mains, from the power reading), so the Home app shows them on the alarm.

### 3.5 More about Texecom Connect (October 2026)

Found on the same panel (Premier Elite 24, V6.05.03, SmartCom) between 8 and 14 October 2026, while testing the Home Assistant port of the same code. Other panels are named where they differ.

**The session**

- **Wait 2 s after connecting before sending the login**: one sent sooner is ignored.
- **Answers can be slow.** Send one command at a time, and resend it with the same sequence number after 3.5 s, up to 5 times; an area-flags read once took over 2.5 s. (The fork's client does both.)
- **Busy NAKs can last.** After a burst of events (~50 s of them), an Elite 88 (V6.02.02, ComIP) answered every keep-alive retry with a NAK (another project, see section 7). It isn't a dead session: skip that read and try again at the next keep-alive rather than reconnecting.
- **Close a dropped socket at once.** A client still holding its own dead socket can't log in again until it's closed, and a second connection is refused outright while one is live (another project).
- **The alarm-time drop and the long refusal window are the SmartCom's.** A dedicated ComIP stayed connected through an alarm and accepted a new login 2 s after a session ended (another project). If a SmartCom also reports to a monitoring centre, a separate ComIP for the plugin avoids both.

**Area flags: which to trust**

`Get area flags` (command 11) returns one area bitmap per flag. On this panel:

| Flag | Seen |
|---|---|
| 21 *Armed* | Clear during the exit delay, set from the moment the area arms. The dependable "armed" flag |
| 23 *Part Armed* | Set about 15 s after the area has armed |
| 19 *Exit*, 24 *Part Arming* | Can still be set once armed: 19 just after a remote arm, and 24 **for the whole time Part Arm 2 or 3 was armed** (neither has anything programmed on this panel; not seen with Part Arm 1). Count them as "in exit" only while 21 is clear, or a re-read after a reconnect shows "Arming…" until the disarm |
| 22 *Full Armed*, 23, 60 *Armed/Alarm*, 63 *Full Armed/Exit* | Stay set for a few seconds after a disarm without 21 (22 and 63 were read 0.35 s after the disarm message; caught up within 4.5 s). Ignore a re-read that shows anything but disarmed for about 5 s after a disarm message |

**Which mode an exit delay is arming to**

The *in exit* area message and log 32 *Exit Started* are the same for Away and every part arm, so a keypad arm's "Arming…" can't take its target from them. The flags say: during a part arm's exit delay, 24 *Part Arming* is set with 19 *Exit* (within 1 s of *in exit*), together with 50, 51 or 52 for Part Arm 1, 2 or 3; during a full arm's, 63 *Full Armed/Exit* is set instead, about 1.5 to 2 s in. Re-read the flags when an exit delay starts, and a few more times until they say (keypad Part Arm 1, Part Arm 2 and Away, 14 October 2026). A V5.02.01 panel's messages didn't say either; whether its flags do is untested.

**Alarms and the entry route**

- **After an alarm the panel can go back to *in entry*** when the entry zone is seen again: *in alarm*, then *in entry* 1.6 s later, then *in alarm* again 16 s after that, with the sirens sounding throughout until the disarm. Keep showing Triggered until the disarm, whatever entry or exit messages arrive in between.
- **A detector that sees the entry route can raise a real alarm.** Walking in, an interior detector saw the person 0.6 s before the entry zone did: the area went *in alarm* (keypad sounder only; the alarm was reported), then *in entry* 0.6 s later. That's the panel's decision, not a false alarm in the plugin.
- **A zone's *alarmed* bit (0x10) stays set until the area is reset** (alarm memory). When naming the zone that set off an alarm, ignore zones in areas that aren't armed: their bit may be left over from earlier.

**Part arms**

- **A part arm with nothing programmed arms every zone**, from the keypad and over Connect (command 6): seen with Part Arms 2 and 3 on 14 October 2026; not tried over Crestron. So a HomeKit button mapped to an unprogrammed part arm can arm the whole house. (Once, choosing a part arm at the keypad showed *Call Engineer* and didn't arm; later tries armed normally. Cause unknown.)
- **Zones a part arm leaves out report *auto bypass*** (zone state bit 6, 0x40) from the start of its exit delay until the disarm.

**Tampers the panel doesn't log**

The panel doesn't always log a tamper. On 8 October 2026 a detector's cover (on the shared auxiliary tamper circuit) was opened three times while disarmed. The first two openings logged 62 *Auxiliary Tamper* group 11 as usual. The third sent **no group 11 at all**, although the keypad showed `AUX 0,0 Tamper` and the internal sounder went off; only the group 12 came, when the cover closed. A limit on repeated alarms (a "swinger" count) is a guess, not confirmed.

That time, area flag **44 *Internal Alarm*** (with 62 *Speaker Mimic*) was set about 1 s after the cover opened. Both cleared once a user code was entered, not when the cover closed. Flag 14 *Tamper Alarm* stayed clear. A rule that works: while an area is disarmed, treat flag 44 set for 5 s with nothing reported to explain it (a tamper, a zone alarm, a failed arm, or the area in exit, entry or alarm) as an unreported tamper, until it clears. Flag 44 is also set during the "fail to set" warning (with 27 *Arm Failed*, 30 *Strobe* and 62), and on V4 firmware while an alarm sounds (another project), so ignore it in those states.

**Power readings**

- **Readings** (command 25): volts = 13.7 + (reading − reference) × 0.07; current = reading × 9 mA.
- **A single reading can be wrong.** With mains on, one read gave 0 mA at 13.14 V and the next, 30 s later, 333 mA at 13.63 V (twice in one morning, 12 October 2026). Testers on a ComWiFi and a ComIP saw a false "mains off" after comms drops. Call it "on battery" only after two such readings in a row (about a minute), and ignore readings below 9 V. The panel's own *AC Fail* log entry still arrives at once.

**Zones changed by the installer**

Re-read zones and areas when any of these arrive, because each can mean zones were added, renamed or moved:

| Log | Means |
|---|---|
| 59 *Installer Programming End* | Engineer programming ended at a keypad |
| 54 *Download End* | A Wintex session ended. **Never logged** for Wintex sessions through a serial adapter on the Crestron port (12 October 2026, and in older entries in the event log) |
| 100 *Site Data Changed* | One per write from Wintex (parameter 1), each with 113 *Remote Command* (group 9, parameter = the Com Port). The dependable signal: re-read once the writes have stopped for about 5 s |

A **full send** from Wintex logged no 100 at all (only 53 *Download Start* when it connected), so nothing signals it: offer a manual re-read. **Reading zone details while Wintex was connected ended the Connect session**, and the SmartCom then turned logins away (80-byte replies) until Wintex disconnected, although the usual status reads carried on during other Wintex sessions. So retry a failed re-read after the next login, and never drop a known zone because its details couldn't be read.

**Panel clock**

- **Connect reads and sets seconds** (commands 23 and 24: day, month, 2-digit year, hours, minutes, seconds). The Crestron `\T` command carries whole minutes only.
- **The clock can hold an impossible date** (day 0, month 0): treat it as "not set" and correct it.
- **It drifts.** On a panel not set up for the Texecom Cloud, the clock was 7 s ahead on 12 October 2026 and 43 s behind on 14 October.
- **A SmartCom corrects the clock only through the Texecom Cloud.** Texecom's SmartCom installation guide (INS760EN-8) says the cloud service uses an NTP server, and that setting a panel up for Texecom Connect programs reporting numbers whose ports, among other things, correct the clock for the country of installation. Panels not set up for the cloud get no correction. Writing only when the clock is more than a minute out leaves a cloud-corrected clock alone. Whether the cloud's correction still happens while another client holds the SmartCom's session is untested.
- **Summer time is untested**: does the panel change its own clock, and does a clock sync then fight it? UK clocks change on 25 October 2026 and 28 March 2027.

**Keypad user names**

`Get user` (command 27, the user number as one byte) returns a user's name **and their code** and settings: 23 bytes on a Premier Elite 24 (V6.05). The name is the first 8 bytes; the code follows as BCD (all `FF` for a user without one). It answers NAK past the last user (25 on a 24-user panel) and for user 0: the engineer, whom keypad events report as user 0, has no user record. Reading all 25 takes about 9 s. If you use it to put names in the log, decode the name only, and never keep, log or show the rest of the reply (including in debug output, and a reply that fails its CRC check).

**Log events, checked against the panel's own event log**

The live log messages from 8 and 12 October 2026 were matched, to the second, against the panel's event log read in Wintex (460 entries), and every one had the same meaning. Details worth knowing:

| Type, group | Wintex shows | Parameter |
|---|---|---|
| 31, 0 | *System Access by User nn* | The user (0 = the engineer) |
| 32, 16 / 32, 17 | *Exit Started* / *Exit Stopped* | Where: 0 a remote arm, 11 the keypad *Net 1 – Rkp 1* |
| 34, 18 | *Entry started by Zone nnn* | The zone |
| 37, 5 | *Area(s) DISARMED* (at a keypad) | The user |
| 42, 6 / 42, 5 | *Area(s) Remote ARMED* / *Remote DISARMED* | 0 |
| 53, 9 | *Download Start* (Wintex connecting) | The Com Port it came in through |
| 74, 13 / 15 / 14 | *User Walk Test* started / zone seen (first time only) / ended. Area flag 33 *Walk Test* is set throughout, so a plugin can tell walk-test movement from real use | 0, or the zone |
| 85, 0 | *Zone nnn Arm Failed* | The zone |

- **The group byte:** the low 6 bits are the group; bit 6 means *communication delayed*, bit 7 *communicated*. Groups 1, 3, 9, 11 and 20 start a condition; 2, 4, 10 and 12 are the matching restores.
- **The event log can miss what was sent live** (one alarm's entries arrived over Connect but aren't in the event log), so don't treat it as complete.
- **Log timestamps are the panel's clock** (7 s ahead that day), not when the message arrived.

**Zone types**

The type number in `Get zone details` (command 3), and in a zone's alarm log entry, is the position in Wintex's *Zone Type* list (confirmed on V6.05.03): 0 Not used, 1 Entry/Exit 1, 2 Entry/Exit 2, 3 Guard, 4 Guard Access, 5 24hr Audible, 6 24hr Silent, 7 PA Audible, 8 PA Silent, 9 Fire, 10 Medical, 11 24hr Gas, 12 Auxiliary, 13 Tamper, 14 Exit Terminator, 15 Moment Key, 16 Latch Key, 17 Security, 18 Omit Key, 19 Custom, 20 Conf PA Audible, 21 Conf PA Silent. The type says nothing about the detector (a door contact and a motion detector can both be *Guard*), so the zone's name is the only clue to contact versus motion.

### 3.6 Firmware and module differences

From diagnostics shared by testers, and from other projects (credited in section 7). Worth knowing before relying on any one panel's behaviour:

| Panel / module | Differs |
|---|---|
| Elite 24, **V5.02.01** | No area states 6–8: a keypad Part Arm 2 sent *part armed* (4) with log 79 *Part Arm 2* and nothing after it; a keypad full arm sent *armed* (3) with log 43 *Quick Arm* (group 6). When the entry/exit zone opened during the exit delay, it sent log **127** (group 5 *Open*, then 6 *Close* when it closed) and a **two-byte** output message `03 e0` (output messages are normally three bytes). Neither is in Texecom's published lists: a parser must skip short or unknown messages, not fail on them |
| Elite 24, V6.06.03, **ComWiFi** | The ComWiFi listens on port **10002** (a SmartCom or ComIP: 10001) |
| Elite 48, **V4.02.01** (another project) | Answers a bulk area-flag read with one byte, so flags are read one at a time. Flag 0 *Alarm* was clear while the alarm sounded and set after the disarm, like an alarm memory (5, 28, 30, 44, 61 and 62 were set while it sounded), so a flag re-read after a keypad disarm would show Triggered again. Not yet checked on V6 |
| Elite 88, V6.02.02, ComIP (another project) | After disarming Part Arm 2, the *disarmed* area message didn't always arrive; a periodic re-read corrects it |
| System flags (command 10), last byte | `01` on V6.05.03; `03` on V6.06.03 and V5.02.01; `00` on an Elite 64, V5.00.03. Meaning unknown |

---

## 4. What the fork adds, and why

### 4.1 Texecom Connect support

**Why:** most users own a **SmartCom**. With Crestron they must switch its COM port over, which loses the Texecom app and its notifications. Connect uses the SmartCom as it is.

| | Crestron | Connect |
|---|---|---|
| SmartCom | COM port switched to Crestron System | Left as it is |
| Zones and areas | Listed in the config | Read from the panel, with names |
| Arm mode in HomeKit | Guessed for keypad arms | Exact, from the panel |
| After a HomeKit command | ~30 s blackout (with logout) | None |
| Texecom app | Lost | Blocked while connected; alarm push still arrives |

`"protocol": "connect"`. It's self-contained, so it can be taken without the rest of the fork:

```
lib/connect/protocol.js   framing, CRC-8, commands, message decoding
lib/connect/client.js     session: login, events, one command in flight, sequence-matched
                          replies, retries, 30 s keep-alive, drop detection, reconnect
lib/connectPanel.js       discovery, full state read on (re)connect, part-arm tracking,
                          setMode() with reset-before-disarm and disarm-before-re-arm
lib/connect/NOTICE        credits: texecom-connect (Apache-2.0), texecom2mqtt (MIT)
```

Part Arm 1/2/3 map to Home app modes with `part_arm_1`…`part_arm_3` (default Night / Home / unused). The exit delay shows "Arming…". A mode switch never shows Disarmed in between, and the alarm shows **Tampered** and **Fault** (mains, battery, communication) from the panel (see 3.3).

### 4.2 Crestron improvements

- **All of section 2.**
- **Exact part arm:** `night_part_arm` / `home_part_arm` send the binary `S 00 0n` instead of `\Y`. Unset keeps `\Y`.
- **Status check every 60 s** (`ASTATUS`, `status_poll_interval`): corrects HomeKit after a missed event, and reconnects if the panel stops answering three times. A periodic "not armed" never clears Triggered, because the panel never reports an alarm ending.
- **"Arming…"** from `"X`; **tamper** from zone status `2`.
- **HomeKit answered at once**, outcome applied when the transaction ends (see 3.4).
- **Binary fallback:** a text command answered `ERROR` is resent as its binary equivalent (see 3.2).
- **Held events coalesced:** in the burst after a session, an arm followed by a disarm no longer flashes a stale "armed" state.

### 4.3 Choosing the Home app arm buttons

`homekit_modes` (e.g. `["away", "night"]`) offers only the buttons a panel uses. Many homes have just a full arm and one part arm, so otherwise Night and Home would do the same thing. Because iOS caches the buttons (3.4), a reduced set gives the alarm accessory its own identity.

### 4.4 Settings page and README

The settings page has four numbered sections, with plain-English help and a recommendation on every field. Fields that don't apply to the chosen protocol are hidden, and the problems in 2.11 are fixed. The [README](https://github.com/metaljay/homebridge-texecom/blob/master/README.md) is a step-by-step guide for SmartCom owners, with screenshots.

### 4.5 Code layout and tests

```
lib/platform.js        platform: config, accessories, routing panel messages
lib/connection.js      Crestron transport: line framing, reconnect, keep-alive, command
                       queue, logout, status check
lib/protocol.js        Crestron parsing and command encoding (pure, unit-tested)
lib/areaAccessory.js   area → HomeKit Security System
lib/zoneAccessory.js   zone → HomeKit sensor (dwell, tamper)
lib/connect/, lib/connectPanel.js   Texecom Connect
test/                  62 tests: parsing, framing, command queue, Connect client and
                       platform, and a replay of the real panel session through real HAP
tools/                 fake panels, session replay, probes used on the real panel
```

`npm install && npm run lint && npm test`. No panel needed.

---

## 5. Suggested route

1. **Keep your accessory identities.** The fork uses a new UUID scheme (`homebridge-texecom-full:zone:7`), so adopting its accessory code as-is would make every user set up their Home app again. Also keep your configurable users (#25), combined areas and clock sync.
2. **Take section 2 as small patches against your code**, most serious first: 2.1, 2.2, 2.3, 2.4, then the rest. Each is independent and easy to review. Separate branches can be prepared on request.
3. **Consider Connect** as a second protocol, from the self-contained files in 4.1.
4. The fork's structure and tests are there as a reference if you want them.

---

## 6. Testing done

| Test | Result |
|---|---|
| 4.4.0 vs the fork, fake panel and real-session replay | Bugs in section 2 reproduced on 4.4.0, fixed in the fork |
| Fork as the live plugin on the real panel (Crestron, Homebridge 2.4) | Running day to day |
| Crestron, HomeKit Night (binary Part Arm 1) held 20 s, then Off | Armed and disarmed, confirmed by the panel's own events |
| Crestron, binary part arm and disarm with a probe tool | Both carried out |
| Crestron, binary logout | Blackout ~60 s → ~30 s; HomeKit blind ~68 s → ~39 s per command |
| Connect, read-only (login, discovery, states, live events) | Correct |
| Connect, HomeKit Night then Off | Night in ~9 s (a remote arm's exit time: with option 58 *Remote Arm Instant* on, remote arms set after about 10 s and keypad arms after 15 s with the same programmed exit delay, so the option shortens the exit time rather than skipping it), Off in under 1 s, no blackout |
| Keypad arm, entry delay and keypad disarm | Seen correctly |
| Homebridge 1.11 and 2.4 | Both |
| Keypad emulation, UDL memory reads | Don't work on V6.05.03 (see 3.2) |
| Connect (through a Home Assistant port of the same code, same panel): Away, Night, Part Arm 2, mode switches, keypad arms, failed arms, three alarms, panel lid and detector tampers, two mains failures, a full power-down | All as described in 3.3; the Home app via HomeKit Bridge showed Away / Night / Off and followed keypad arms |

Not yet exercised on the real panel with this plugin itself: the Tampered/Fault characteristics and the mode-switch fix (covered by tests against the fake panel).

### How to test against a real panel

What worked, for anyone repeating these tests:

- **One client at a time.** Turn off every other Connect client (the Texecom app, another Homebridge, texecom2mqtt, Home Assistant) before connecting a test instance, and turn it back on afterwards.
- **Sort each test by risk:** read-only (any time); changes the panel but doesn't arm or sound it, e.g. setting the clock (ask the panel's owner first); arms, sounds, cuts power or opens a tamper (only with the panel's owner present and agreeing, and they disarm at the keypad).
- **Alarm tests are loud and may be reported.** Agree a time, warn the household and neighbours, and if the alarm is monitored, tell the monitoring centre or put it in test mode first.
- **Don't cut all power** (mains and battery) unless you mean to: it resets the panel clock.
- **Never record a code.** Keep logs and fixtures free of the UDL and keypad codes; if a reply contains codes (`Get user`), note only its format.
- **Use Wintex for reading only, and note the time of every step to the second.** Matching the live messages against the panel's own event log in Wintex afterwards is the quickest way to confirm what a message means.
- **Make the simulated panel misbehave like the real one.** Besides the normal replies, it should be able to hang up about 1.5 s after the disarm that follows an alarm, then turn logins away for ~2 minutes (80-byte frames it doesn't recognise, and a frame with a bad CRC); NAK the next *n* reads; open a tamper without logging it; report *AC Fail* with no restore; and start with its clock at 31 Oct 2023. Most of the problems in section 8 show up there first.
- **Turn users' captures into regression tests.** A capture a user shares (their zones, areas and the messages their panel sent) can become a simulated panel that replays them. Keeping each one as a test means a change can't quietly break a panel nobody here owns.

---

## 7. Other projects and credits

| Project | Licence | Used for |
|---|---|---|
| [texecom2mqtt](https://github.com/dchesterton/texecom2mqtt-hassio) | MIT | Connect protocol details; reference feed in testing |
| [davidMbrooke/texecom-connect](https://github.com/davidMbrooke/texecom-connect) | Apache-2.0 | The original Connect reverse-engineering |
| [Sjoerdfc](https://github.com/Sjoerdfc/texecom-connect) / [southseaboy](https://github.com/southseaboy/texecom-connect) forks | Apache-2.0 | Idle-time state re-read; all 73 area flags; short-read fallback; "an ACK isn't proof" |
| [michaelmarconi/texecom_alarm](https://github.com/michaelmarconi/texecom_alarm) | MIT | NAK replies after event bursts; area states 6/7; drops at alarm time |
| [JumpMaster/TexecomManager](https://github.com/JumpMaster/TexecomManager) | | Crestron messages, `ASTATUS`/`LSTATUS`, tamper status |
| [shuckc/pytexalarm](https://github.com/shuckc/pytexalarm) / pialarm | MIT | Wintex/UDL framing, binary commands |
| [ricol99/casa](https://github.com/ricol99/casa) | MIT (package.json) | Binary arm/part-arm/disarm commands |
| [GoosieZA/esphome-texecom](https://github.com/GoosieZA/esphome-texecom) | MIT | UDL differences between Elite and International panels |
| [Prinsessen/openhab-texecom-bridge](https://github.com/Prinsessen/openhab-texecom-bridge) | MIT | Periodic `ASTATUS` with a watchdog |
| [dxnphillips/scouthut-alarmnotification](https://github.com/dxnphillips/scouthut-alarmnotification) | MIT | The "connected but panel silent" failure mode |
| [garethflowers/homebridge-texecom-connect](https://github.com/garethflowers/homebridge-texecom-connect) | MIT | Keypad-emulation arming (not accepted by this panel) |

The same protocol work is also available as a Home Assistant integration: [metaljay/ha-texecom](https://github.com/metaljay/ha-texecom).

Original plugin by Kieran Jones, maintained by Max Christian and Chris Posthumus. Protocol credits for the Connect code are in [lib/connect/NOTICE](https://github.com/metaljay/homebridge-texecom/blob/master/lib/connect/NOTICE).

---

## 8. Later findings (October 2026)

Found while testing the Home Assistant port of the same code on the same panel (Premier Elite 24, V6.05.03). They apply to the fork's Connect code as it stands (`master`). The fork is archived, so they're noted here rather than fixed.

| # | Where | What happens | Fix |
|---|---|---|---|
| 1 | `lib/connectPanel.js:322` | Healthy power readings clear every name in `MAINS_FAULTS`, including **PSU AC Fail** (log 107: a *remote* power supply's mains). A real PSU mains failure disappears within 30 s, although the panel's own mains is fine and the PSU's isn't | Clear only *AC Fail* from the readings; leave *PSU AC Fail* to its own restore log |
| 2 | `lib/connectPanel.js:317` | 0 mA below 13.3 V counts as "on battery". A panel whose current always reads 0, or one read just after a restart while on battery, gets the wrong answer | Trust 0 mA only once the panel has reported a non-zero current since connecting; otherwise require a clearly low voltage (below ~12.9 V). Also require two "on battery" readings in a row, and ignore readings below 9 V: a single reading can be wrong (3.5) |
| 3 | `lib/areaAccessory.js:124,130` | Crestron `"A0010` / `"D0010` (e.g. the held-back event after a UDL arm) is logged as "by user 0" | User 0 means nobody: don't credit it to anyone |
| 4 | `lib/connection.js:131` | While the Crestron bridge is down, every reconnect attempt logs an error | One warning after a few failures, then quiet until it's back |
| 5 | Connect | Tampers and faults that started before Homebridge connected aren't known (they only come from log events), so after a restart *Tampered* / *Fault* stay clear until the next change. Mains is the exception (the power reading) | No read-only way found yet. Flag 14 *Tamper Alarm* stayed clear with a cover open; flag 44 *Internal Alarm* shows an open cover only while the internal sounders run (3.5); system flags byte 0 read `10` then and `40` once after an alarm, and byte 2 `08` with mains off, but they aren't understood. Reading the last few event-log entries on connecting is the other candidate (untested). |
| 6 | Design | The keep-alive work (state, power, keypad text) runs when no command has been sent for 30 s. That's fine as the fork stands, but anything that sends commands as zones change (e.g. re-reading "Ready" whenever a detector clears) starves it while people move about, and the mains restore goes unseen | Run that work on its own timer, not only when idle |
| 7 | `lib/connect/protocol.js:206` (`decodeAreaFlags`) | 19 *Exit* and 24 *Part Arming* are checked before *Armed*, and 22/23 count as armed without 21. The real panel kept 24 set for the whole time an unprogrammed Part Arm 2 or 3 was armed, and 22/23 for a few seconds after a disarm (3.5), so a re-read can show "Arming…" while armed (after a reconnect), or armed just after a disarm | Check 21 first, and count 19/24 as exit only while 21 is clear; ignore non-disarmed flag reads for ~5 s after a disarm message |
| 8 | `lib/areaAccessory.js:190` (`in exit`) | A keypad arm's "Arming…" target is always the default mode | Take it from the flags: 24 with 50–52 for a part arm, 63 for a full arm (3.5) |
| 9 | `lib/connectPanel.js:282` | Tampers come only from log events, and the panel doesn't always log one | Fall back on area flag 44 *Internal Alarm* while disarmed (3.5) |
| 10 | `lib/connectPanel.js:294` | Zones and areas are re-read only after 59 *Installer Programming End* | Also after 100 *Site Data Changed* (once quiet for ~5 s) and 54; retry after the next login if the re-read fails; keep known zones whose details couldn't be read (3.5) |

**More about the panel (V6.05.03):**

- **Area flags while disarmed and quiet:** 16 *Ready*, 25 *Force Armable*, 29 *Bell SCB*, 32 *Detector Reset*, 67 *LED control*. 16 and 25 clear together while any detector is active, and come back once it clears (a bulk read about 2 s later shows it). **System flags** (command 10, 8 bytes) read `00 20 09 00 00 00 00 01` in the same state.
- **The SmartCom's refusal window**, measured: after a client restarts, a new login got in after 4–20 s. Straight after a short session closed (a setup check), the first login was closed by the panel and the next, 5 s later, was accepted. Later tests saw up to about 70 s.
- **Finding the SmartCom:** it registers on the network as **`texe_hub`** (its MAC prefix is Microchip's), which helps users spot it in their router's device list.
- **A Connect login doesn't add anything to the panel's event log** (no *Download Start/End*).

**For users (ideas that worked well in the Home Assistant version):** say *not connected* and *refused* separately when an arm fails; put keypad user names in the log instead of numbers; and for a tamper, say where to look (*Panel Box Tamper* is the lid; *Auxiliary Tamper* is a detector's cover on the shared circuit).
