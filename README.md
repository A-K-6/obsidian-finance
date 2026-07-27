# Vault Finance

A private, local-first personal finance manager for [Obsidian](https://obsidian.md). Track cash, bank accounts, credit cards, and multi-currency transactions without sending financial data to an external service.

## Highlights

- Cash, bank, and credit-card accounts
- Expenses, income, refunds, transfers, and card payments
- Fast everyday expense entry with optional advanced fields
- Edit, search, filter, and delete transactions
- Current net balance across active accounts
- Weekly and monthly summaries
- Multi-currency accounts and cross-currency transfers
- Live comma grouping and localized amount previews
- Credit limits and available-credit calculations
- Right-sidebar dashboard
- Stable transaction references inside Markdown notes
- Command Palette and customizable Obsidian hotkeys
- Desktop and mobile support
- No network requests or telemetry

## Dashboard

Vault Finance opens its dashboard in Obsidian's right sidebar. It provides:

- **Current balance:** cash and bank balances minus credit-card balances.
- **Per-currency totals:** unrelated currencies are never incorrectly combined.
- **Account cards:** current balance or amount owed, plus available credit where applicable.
- **Weekly and monthly summaries:** spending, income, and net activity.
- **Recent transactions:** edit, delete, or insert a reference into the active note.
- **Quick actions:** add a transaction, add an account, or open transaction history.

Archived accounts are excluded from the current-balance total.

## Accounts

Create an account from the dashboard or from **Settings → Vault Finance**.

Supported account types:

- **Cash**
- **Bank**
- **Credit card**

Each account has one currency and an opening balance. Credit-card accounts can also have an optional credit limit and optional last four digits for identification.

Once an account has transactions, its type and currency cannot be changed because doing so would reinterpret historical amounts. Its name, opening balance, credit limit, and descriptive details can still be edited.

## Adding transactions

The default transaction form is intentionally minimal:

1. Enter the amount.
2. Add an optional description.
3. Choose an account.
4. Select **Add transaction**.

Amount fields add comma separators while you type—for example, `125000000` becomes `125,000,000`. A localized currency preview appears below the field.

Select **Advanced options** to change the transaction type or add a custom date, category, or note.

### Transaction types

- **Expense:** decreases a cash/bank balance or increases a credit-card balance.
- **Income:** increases a cash/bank balance.
- **Refund:** reverses spending and decreases a credit-card balance or increases a cash/bank balance.
- **Transfer:** moves money between cash/bank accounts without counting it as income or spending.
- **Card payment:** moves money from cash/bank to a credit card without counting the payment as a second expense.

## Multi-currency support

Each account uses one currency. Vault Finance supports common zero-, two-, and three-decimal currencies, including **IRR — Iranian Rial**.

Money is stored as integer minor units rather than floating-point numbers. For example, `12.34 USD` is stored as `1234`. This avoids common floating-point rounding errors.

Weekly summaries, monthly summaries, and current balances remain separated by currency. Vault Finance does not fetch exchange rates or combine unrelated currencies.

For a cross-currency transfer, enter both:

- The amount sent from the source account
- The amount actually received by the destination account

## Transaction history

Open **Vault Finance: Open transaction history** to:

- Search descriptions, categories, and notes
- Filter by transaction type
- Edit transactions
- Delete transactions with confirmation
- Insert transaction references into the active note

## Referencing transactions in notes

Every transaction has a stable ID. While editing a note, run **Vault Finance: Insert transaction reference** and select a transaction.

The command inserts:

````markdown
```vault-finance
transaction: transaction-id
```
````

In Reading view, the block renders the transaction's current type, amount, date, account, and description. Because the block references the original transaction instead of duplicating it, edits are reflected the next time the note is rendered.

You can also use **Add reference to current note** beside a transaction. In Editing mode, the reference is inserted at the cursor. In Reading mode, it is appended to the currently open Markdown note and Vault Finance confirms the note name.

## Commands and hotkeys

Vault Finance currently registers these commands:

- **Open dashboard**
- **Open transaction history**
- **Add transaction**
- **Add account**
- **Insert transaction reference**

All commands appear in Obsidian's Command Palette. To assign or change keyboard shortcuts, open **Settings → Hotkeys** and search for `Vault Finance`.

Vault Finance does not define default hotkeys, avoiding conflicts with other plugins.

## Settings

Available settings include:

- Default currency for new accounts
- Display locale for currency formatting
- First day of the week
- Default transaction account
- Account creation, editing, and archiving

Settings are searchable on Obsidian 1.13 and later while remaining compatible with older supported Obsidian versions.

## Data storage

Vault Finance stores its data through Obsidian's local plugin storage:

```text
<vault>/.obsidian/plugins/vault-finance/data.json
```

The file contains:

- Plugin settings
- Accounts
- Transactions and their stable IDs

Balances and reports are calculated from the stored transactions instead of being saved as duplicate totals.

Your vault backup or synchronization setup determines how this file is copied between devices. Back up your vault regularly.

## Privacy and safety

Vault Finance:

- Makes no network requests
- Includes no telemetry
- Does not read or write the system clipboard
- Does not connect to banks or card providers
- Stores data locally inside the vault configuration

**Never enter a complete card number, security code, PIN, banking password, API key, or other authentication secret.** The optional card field accepts only the last four digits.

## Installation

### Community plugins

After the Community directory review is complete:

1. Open **Settings → Community plugins**.
2. Select **Browse**.
3. Search for **Vault Finance**.
4. Select **Install**, then **Enable**.

If the directory review is still in progress, use a GitHub release or BRAT.

### GitHub release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/A-K-6/obsidian-finance/releases/latest).
2. Create `<your-vault>/.obsidian/plugins/vault-finance/`.
3. Copy the three files into that folder.
4. Reload Obsidian.
5. Enable **Vault Finance** under **Community plugins**.

### BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add:

```text
https://github.com/A-K-6/obsidian-finance
```

## Compatibility

- Minimum Obsidian version: **1.7.2**
- Desktop-only: **No**
- Current plugin version: **1.0.5**

The plugin uses the declarative settings API on Obsidian 1.13+ and maintains a legacy settings fallback for earlier supported versions.

## Current limitations

- Transactions are entered manually; automatic bank synchronization is not included.
- Live exchange rates and automatic currency conversion are not included.
- Apple Shortcuts and custom URI automation are not yet implemented.

## Development

```bash
npm install
npm run dev
```

Run linting, tests, type checking, and a production build:

```bash
npm run check
```

The production bundle is written to `main.js`.

## Releasing

A GitHub release tag must match the version in `manifest.json` and include:

- `main.js`
- `manifest.json`
- `styles.css`

## License

[MIT](LICENSE)
