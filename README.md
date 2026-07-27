# Vault Finance

A minimal, private, local-first personal finance manager for [Obsidian](https://obsidian.md).

## Features

- Cash, bank, and credit-card accounts
- Expenses, income, refunds, transfers, and credit-card payments
- Add, edit, search, filter, and delete transactions
- Weekly and monthly summaries
- Multi-currency accounts and cross-currency transfers
- Credit limits and available-credit display
- Responsive dashboard and transaction history
- Local Obsidian storage with no network calls or telemetry

## Currency handling

Each account has one currency. Amounts are stored as integers in the currency's smallest unit, avoiding floating-point rounding errors. The plugin supports common zero-, two-, and three-decimal currencies.

Weekly and monthly totals are shown separately for each currency. Vault Finance intentionally does not add unrelated currencies or fetch live exchange rates. A cross-currency transfer records both the amount sent and the amount actually received.

## Transaction rules

- **Expense** increases a credit-card balance or decreases a cash/bank balance.
- **Income** increases a cash/bank balance.
- **Refund** reverses spending and lowers a credit-card balance or increases a cash/bank balance.
- **Transfer** moves funds between cash/bank accounts and is not income or spending.
- **Card payment** moves funds from cash/bank to a credit card and is not counted as a second expense.

## Privacy and safety

Data is saved locally through Obsidian's plugin storage in `.obsidian/plugins/vault-finance/data.json`. The plugin makes no network requests.

**Never enter a full card number, CVV, PIN, banking password, or other authentication secret.** The optional card field accepts only the last four digits for identification.

Your vault sync and backup configuration determines how this data is copied between devices. Back up your vault regularly.

## Installation

### From a GitHub release

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `<your-vault>/.obsidian/plugins/vault-finance/`.
3. Copy the three files into that folder.
4. Reload Obsidian and enable **Vault Finance** under **Community plugins**.

You can also install the repository with [BRAT](https://github.com/TfTHacker/obsidian42-brat) while it is awaiting inclusion in the Obsidian community directory.

## Usage

1. Open **Settings → Vault Finance** and add an account.
2. Choose the ribbon icon or run **Vault Finance: Open dashboard**. The dashboard lives in the right sidebar by default.
3. Add an everyday expense with only its amount, description, and account. Use **Advanced options** for another transaction type, date, category, or note.
4. Open transaction history to search, edit, delete, or insert a reference to a transaction in the active note.

## Referencing transactions in notes

Every transaction has a stable ID. Use **Vault Finance: Insert transaction reference** from the command palette while editing a note, then choose a transaction. The command inserts:

````markdown
```vault-finance
transaction: transaction-id
```
````

In Reading view, the block renders the transaction's current amount, date, type, account, and description. Editing the original transaction updates what is rendered the next time the note is rendered. You can also insert this block into the active note using the link button beside a transaction in the dashboard or history.

## Data storage

Accounts, settings, and transactions are stored in `.obsidian/plugins/vault-finance/data.json` through Obsidian's local plugin storage. Amount fields add comma separators while you type and show a localized preview. Stored amounts remain exact integer minor units, and records use stable IDs. Reports and balances are derived from the transaction records rather than stored as duplicate totals.

## Development

```bash
npm install
npm run dev
```

For a production build and tests:

```bash
npm run check
```

The production bundle is written to `main.js`.

## Release files

An Obsidian release must use a tag matching the version in `manifest.json` and include:

- `main.js`
- `manifest.json`
- `styles.css`

## License

[MIT](LICENSE)
