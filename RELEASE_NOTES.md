## Highlights

- **Combined areas.** One accessory can arm and disarm several areas at once, set up under `area_groups`. The areas go to the panel in a single command. A combined area shows as armed once all its areas are armed, and an alarm in any of them shows straight away.
- **Panel clock sync.** Set `time_sync_interval` to the number of hours between checks, from 1 up to 744 (31 days). The plugin compares the panel clock with the machine running Homebridge and corrects any drift. It also checks shortly after connecting, so a panel that lost its time in a power cut is put right. Off by default. Needs a UDL, as arming does.
- **Configurable arm reporting.** `remote_users`, `app_users` and `default_arm_state` decide how an arm is reported to HomeKit, instead of user numbers fixed in code (#25).

## Upgrading

- **From 4.2.8 or earlier:** nothing to do. Accessories carry over with their rooms, names and automations.
- **From 4.3.0:** 4.3.0 published accessories outside the bridge. To keep them and the scenes and automations built on them, turn on `external_accessories`. Leave it off to get bridged accessories, which will need setting up again in the Home app.

## Fixes

- Accessories are bridged again, as in 4.2.8 and earlier, and are cached across restarts. Accessories removed from the config are unregistered.
- Arming or disarming areas 5 to 8 addressed the wrong areas, and area 8 sent a malformed command. Present since 4.2.8.
- The first arm or disarm from a HomeKit button is no longer ignored (#26).
- A full arm no longer changes to Night in the Home app a minute later (#25).
- The arm/disarm command is retried once when the panel ignores the first write, and the retry timer is cleared once the panel answers. Before, every command also sent a second login two seconds later.
- Areas and zones that share a number no longer share a serial number.
- User numbers over 99 are no longer truncated.
- Areas are matched by area number rather than by their position in the config.

## Other

- Runs on Homebridge 1.x again as well as 2.x.
- Removed the unused `crypto-js` dependency.

## Contributors

- @K1LL3R234 - development and maintenance of this release
- @badgertastic - reported and helped test #25 and #26
- @max-christian - original author of homebridge-texecom
- @kieranmjones - code contributions
- @garethflowers - code contributions

Full details in the [changelog](https://github.com/K1LL3R234/homebridge-texecom/blob/master/CHANGELOG.md).