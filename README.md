# SkillQ
A web based Skill Monitor for Eve Online.

[![Login with EVE Online](./img/ssologin.png)](https://skillq.net/login-check)

### What is SkillQ?
SkillQ lets you monitor all your EVE Online characters in one place from any browser.

**Everything is stored locally in your browser.** SkillQ does not run a backend database or user-account system. Your character data, wallet history, and settings are kept entirely in your browser's IndexedDB and are never sent to any SkillQ server. Logging out erases all locally stored data from the device.

### Features

- **Multi-character dashboard**: view all your characters on one page with live training countdowns and wallet balances
- **Skill overview**: browse every trained skill grouped by category, with queue and training-in-progress highlights
- **Skill queue**: see the full active queue with finish times and SP/hour rates
- **Training advisor**: ranked list of skills to train next based on your current attributes and implants
- **Wallet journal**: recent wallet transactions with party name resolution
- **Character groups and ordering**: organise characters into named groups and sort by SP, ISK, queue finish time, or a custom order
- **Shareable character links**: generate a signed, compressed share URL that lets anyone view a snapshot of your skills and queue (automatically invalidates if you change corporations)
- **Fully local storage**: all data lives in your browser's IndexedDB; no SkillQ account or server-side database required
- **Dark / light / system theme**: choose your preferred colour scheme from Settings
- **Restricted or fluid layout**: fixed three-column card layout or fluid full-width mode

Here are some example screenshots:

![Dashboard](./img/skillq_dash.png)

![Character Page](./img/skillq_example.png)
