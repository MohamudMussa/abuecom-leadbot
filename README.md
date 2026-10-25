# Abu Ecom lead bot

Every 5 minutes GitHub checks the Meta lead form and posts new leads to Slack #leads, with a one-tap WhatsApp button (number cleaned, opener pre-typed) and a junk check.

- Secrets: `META_TOKEN` (page token with leads_retrieval), `SLACK_WEBHOOK` (#leads incoming webhook)
- Variable: `FORM_IDS` (comma-separated lead form IDs)
- Test: Actions → "Check for new leads" → Run workflow → tick "Post a fake test lead".

No lead data is stored here. `state.json` only holds a timestamp and hashed lead IDs.
