# Obsidian Finance

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

Weekly and monthly totals are shown separately for each currency. Obsidian Finance intentionally does not add unrelated currencies or fetch live exchange rates. A cross-currency transfer records both the amount sent and the amount actually received.

## Transaction rules

- **Expense** increases a credit-card balance or decreases a cash/bank balance.
- **Income** increases a cash/bank balance.
- **Refund** reverses spending and lowers a credit-card balance or increases a cash/bank balance.
- **Transfer** moves funds between cash/bank accounts and is not income or spending.
- **Card payment** moves funds from cash/bank to a credit card and is not counted as a second expense.

## Privacy and safety

Data is saved locally through Obsidian's plugin storage in `.obsidian/plugins/obsidian-finance/data.json`. The plugin makes no network requests.

**Never enter a full card number, CVV, PIN, banking password, or other authentication secret.** The optional card field accepts only the last four digits for identification.

Your vault sync and backup configuration determines how this data is copied between devices. Back up your vault regularly.

## Installation

### From a GitHub release

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `<your-vault>/.obsidian/plugins/obsidian-finance/`.
3. Copy the three files into that folder.
4. Reload Obsidian and enable **Obsidian Finance** under **Community plugins**.

You can also install the repository with [BRAT](https://github.com/TfTHacker/obsidian42-brat) while it is awaiting inclusion in the Obsidian community directory.

## Usage

1. Open **Settings → Obsidian Finance** and add an account.
2. Choose the ribbon icon or run **Obsidian Finance: Open dashboard**.
3. Add transactions with the dashboard button or **Obsidian Finance: Add transaction**.
4. Open transaction history to search, edit, or delete records.

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
