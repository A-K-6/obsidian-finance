# Vault Finance

Vault Finance is a private, local-first personal finance manager for [Obsidian](https://obsidian.md). Version 2 adds reusable categories, calendar-aware budgets and recurring planning, and fuller credit-card management while preserving the account and transaction model from version 1.

## Highlights

- Cash, bank, and credit-card accounts
- Expenses, income, refunds, transfers, and card payments
- Reusable typed expense and income categories
- Monthly expense-category budgets, always separated by currency
- Weekly, monthly, and yearly recurring planning with manual confirmation
- Gregorian and Persian calendar display and arithmetic
- Credit-card statements, minimum payments, utilization, and reminders
- Right-sidebar dashboard plus a normal Planning tab
- Searchable history and stable transaction references in Markdown notes
- Integer minor-unit money with overflow checks
- Desktop and mobile support through native Obsidian APIs
- No network requests, telemetry, bank syncing, system notifications, or silent actions

## Dashboard and Planning

The **Finance dashboard** remains in Obsidian's right sidebar. It shows current balances, net totals by currency, account cards, weekly and calendar-month summaries, planning reminder counts, and recent transactions.

Open **Vault Finance: Open planning** or select **Planning** on the dashboard for a normal tab with clearly separated sections:

- **Budgets:** current calendar-month Budget, Spent, Remaining, and textual **Overspent** or **Within budget** status.
- **Recurring:** recurring rule management and active/paused status.
- **Credit cards:** current amount owed, utilization, statement balance, minimum payment, and schedule details.
- **Upcoming:** due and upcoming recurring occurrences plus card payment reminders.

Nothing in either view posts a transaction or initiates a payment automatically.

## Accounts and credit cards

Accounts are Cash, Bank, or Credit card, each with one explicit currency. Once an account has transactions, its type and currency cannot change because that would reinterpret history.

Credit-card-only fields are shown only when the account type is Credit card:

- Optional last four digits
- Credit limit
- Statement closing day (1–31)
- Payment due day (1–31)
- Statement balance
- Minimum payment

Days that do not exist in a shorter month clamp to that month's final day. Statement and minimum-payment amounts use the card account's currency, and the minimum payment cannot exceed the statement balance. Current utilization is calculated from current amount owed divided by credit limit; it is not a saved duplicate total.

Card reminders are in-app planning information only. Vault Finance never sends a system notification, contacts an issuer, or initiates a payment.

## Categories

Categories are reusable records typed as **Expense** or **Income**. Refunds use expense categories so refunded spending can reduce the matching budget. Categories can be created, edited, and archived from Planning. Archiving keeps all historical links intact and pauses related recurring rules.

The transaction form uses a category selector rather than free text. Uncategorized transactions remain supported.

## Monthly budgets

A budget identifies all of the following explicitly:

- Expense category
- Currency
- Calendar system
- Calendar month (`YYYY-MM` in that calendar)
- Integer minor-unit budget amount

Spent is calculated as same-category expenses minus same-category refunds within the exact calendar-month range. Transactions in another category, currency, or month are excluded. Vault Finance never combines currencies and does not infer exchange rates.

## Recurring items and manual confirmation

Recurring expense and income rules include:

- Weekly, monthly, or yearly frequency
- Account, amount, and currency
- Typed category and description
- Canonical anchor and next due dates
- Optional note
- Calendar and active status

Weekly recurrence is always seven absolute calendar days. Monthly and yearly recurrence follows the rule's Gregorian or Persian calendar and clamps month ends while retaining the original anchor for later occurrences.

Recurring items are planning rules, not automatic transactions. To record an occurrence:

1. Open Planning.
2. Select **Record** on an upcoming or due occurrence.
3. Review the prefilled confirmation transaction modal.
4. Select **Save transaction**.

No transaction exists before that explicit Save. Recording the transaction and resolving the occurrence are persisted atomically so the same occurrence cannot be posted twice. **Skip** requires confirmation, creates no transaction, and records the occurrence as skipped to prevent repeated prompts.

## Calendars and stored dates

Choose **Gregorian** or **Persian** in Vault Finance settings. The selected calendar controls displayed dates, calendar-month summaries and budgets, planning, and defaults for monthly/yearly recurring rules.

All persisted absolute dates remain canonical Gregorian `YYYY-MM-DD`. Calendar conversion and all-day arithmetic are isolated from timestamps, avoiding daylight-saving-time shifts. Changing the display calendar does not rewrite transaction dates or timestamps. A budget or recurring rule also stores its calendar explicitly so its month or recurrence keeps a stable meaning.

## Transaction behavior

- **Expense:** decreases a cash/bank balance or increases a credit-card amount owed.
- **Income:** increases a cash/bank balance.
- **Refund:** reverses spending and reduces the matching category's budget spending.
- **Transfer:** moves money between cash/bank accounts without counting as income or spending.
- **Card payment:** moves money from cash/bank to a credit card without counting payment as a second expense.

Cross-currency transfers store the actual source and destination amounts. Reports and balances remain separated by currency.

Money is stored as safe integer minor units rather than floating-point values. For example, `12.34 USD` is stored as `1234`. Zero-, two-, and three-decimal currencies are supported, including IRR.

## History and note references

Open **Vault Finance: Open transaction history** to search descriptions, category names, and notes; filter by type; edit or delete; and add a transaction reference to a note.

A reference uses the stable transaction ID:

````markdown
```vault-finance
transaction: transaction-id
```
````

Reading view renders current transaction details, so later edits are reflected without duplicating financial data into the note.

## Commands and hotkeys

Vault Finance registers:

- **Open dashboard**
- **Open transaction history**
- **Open planning**
- **Add transaction**
- **Add account**
- **Insert transaction reference**

Assign optional hotkeys under **Settings → Hotkeys**. No default hotkeys are claimed.

## In-app reminders

After Obsidian's layout is ready, Vault Finance can show one concise in-app summary for recurring occurrences and card payments that need attention. It avoids repeating the summary within the same plugin load/day where practical. Open Planning to review details.

These are Obsidian in-app notices only. Vault Finance does not claim background delivery, system notifications, network delivery, payment execution, or automatic posting.

## Version 1 migration

On first successful version 2 load, schema version 1 data is validated and migrated to schema version 2:

- Account and transaction IDs are unchanged.
- Dates, timestamps, currencies, and integer minor amounts are preserved exactly.
- Existing free-text categories deterministically become typed category records.
- Expense and refund text share an expense category; income text becomes an income category.
- Transactions receive `categoryId` links, while original category text is retained in migrated persisted data for losslessness.
- New budgets, recurring rules, and resolutions start empty.
- The initial calendar is Gregorian, matching version 1 behavior.

The complete migrated document is saved before it becomes the active in-memory state. If that persistence fails, Vault Finance does not commit the migrated state. Loading valid version 2 data is idempotent and does not rewrite it. Unsupported future schema versions fail without saving, protecting data from an older plugin version.

Back up your vault before any major plugin upgrade.

## Settings compatibility

Settings include default currency, display locale, calendar, first day of week, default account, and account management. Vault Finance uses Obsidian's declarative settings definitions on Obsidian 1.13 and later and retains the existing imperative `display()` fallback for supported Obsidian versions before 1.13. Deprecation warnings for the compatibility fallback may appear during development.

## Data storage and privacy

Vault Finance stores data through Obsidian's local plugin storage:

```text
<vault>/.obsidian/plugins/vault-finance/data.json
```

The file contains settings, accounts, categories, budgets, recurring rules and resolutions, and transactions. Derived balances, utilization, summaries, and budget status are calculated rather than duplicated.

Vault Finance:

- Makes no network requests
- Includes no telemetry
- Does not connect to banks or card providers
- Does not initiate payments
- Does not silently post transactions
- Does not provide system notifications
- Does not use Node or Electron runtime APIs

Never enter a full card number, security code, PIN, banking password, API key, or other authentication secret. The only card identifier field is optional last four digits.

Your vault backup or synchronization setup determines how local plugin data is copied between devices.

## Installation

### Community plugins

After Community directory review:

1. Open **Settings → Community plugins**.
2. Select **Browse** and search for **Vault Finance**.
3. Select **Install**, then **Enable**.

### GitHub release

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/A-K-6/obsidian-finance/releases/latest), copy them to `<vault>/.obsidian/plugins/vault-finance/`, reload Obsidian, and enable Vault Finance.

### BRAT

Add this repository in [BRAT](https://github.com/TfTHacker/obsidian42-brat):

```text
https://github.com/A-K-6/obsidian-finance
```

## Compatibility

- Minimum Obsidian version: **1.7.2**
- Desktop-only: **No**
- Current plugin version: **2.0.0**

## Deliberate limitations

- Transactions and recurring occurrence decisions are manual.
- There is no bank synchronization, telemetry, live exchange rate, automatic conversion, payment integration, or background notification service.
- Apple Shortcuts and custom URI automation are not implemented in this release.

## Development

```bash
npm install
npm run dev
```

Run linting, all tests, type checking, and a production bundle:

```bash
npm run check
```

A production dependency audit can be run with:

```bash
npm audit --omit=dev
```

The bundle is written to `main.js`.

## Releasing

A release tag must match `manifest.json` and include `main.js`, `manifest.json`, and `styles.css`.

## License

[MIT](LICENSE)
