# Spentra

**Know Your Money. Own Your Future.**

Spentra is a personal finance web app that turns your monthly income into a daily spending budget. Every payment you record reduces the day's remaining allowance, and an assistant named Penny answers your money questions.

**Live site:** https://kaicodes-beer.github.io/Spentra/

```
Daily budget = Monthly income / 30
Example: 1,00,000 / 30 = 3,333 a day. Spend 1,750 and 1,583 is left.
```

## Features

- **Daily budget engine:** income divided by 30, updated with every completed expense.
- **30-day cycles:** renew automatically, with cycle history and optional carry-forward of unused allowance.
- **Dashboard:** six overview cards, a progress ring for today, a category donut, trend charts (daily, weekly, monthly, category, income vs spend) and recent transactions.
- **Transactions:** add payments, filter by type, correct categories, delete, and export CSV.
- **Automatic categories:** detected from the merchant name (Swiggy, Blinkit, Amazon, Uber, Netflix and more). Unknown payments show as Uncategorized UPI Payment, and your corrections are remembered.
- **Payment types:** Expense, Income, Refund and Self transfer. Own-account transfers are never counted twice, and failed payments are ignored.
- **Financial score (0 to 100):** only overspending on non-essentials lowers it. Groceries, transport, healthcare, education and bills are never penalised.
- **Analytics, Calendar and Savings Goals:** category breakdowns, a spending heatmap with a no-spend streak, and progress bars for goals.
- **Alerts:** a bell menu with a morning budget message, a note for each expense, an 80% warning, an overspend alert and a daily report notice.
- **Light and dark themes**, a desktop sidebar and a mobile bottom bar.


## Project structure

```
index.html        The whole website (HTML, CSS and JavaScript in one file)
server.js         Optional backend: Express + MySQL 
schema.sql        MySQL database schema

```

## Privacy and security

- Spentra never asks for bank passwords, UPI PINs or OTPs.
- There is no live bank connection. Payments are entered by hand.
- On the website, data is stored in the browser on your device only. It does not sync, and clearing browser data erases it.
- Passwords are salted and hashed before storage.
- Use Settings to clear transactions or delete your account at any time.
- Do not commit `.env` files, API keys or database files to this repository.
- Do not enter real financial details on a public deployment until the site is connected to the full backend.

## Known limitations

- Single account per device.
- No bank or Account Aggregator integration yet.
- Notifications appear inside the app only, not as push notifications.
- CSV export only, with no PDF export.
- Google sign-in and password reset need a backend and are not active.

## Tech stack

HTML, JavaScript, MySQL 

