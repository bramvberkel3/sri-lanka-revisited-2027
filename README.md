# Sri Lanka 2027 – shared trip planner

A small web app that Bram and Andreea can use to plan the trip together, on any device and at the same time. Changes appear live on the other person's screen.

* **Hosting:** GitHub Pages (free)
* **Login + shared database:** Google Firebase (free "Spark" plan is plenty)
* **Maps:** OpenStreetMap (free, no key needed)

Setup takes about 15–20 minutes and only has to be done once.

---

## 1. Create the Firebase project (about 10 min)

1. Go to <https://console.firebase.google.com> and sign in with your Google account.
2. **Create a project** → name it e.g. `srilanka-2027` → you can switch Google Analytics off → **Create**.
3. **Turn on login**
   * Left menu **Build → Authentication → Get started**.
   * Tab **Sign-in method** → **Email/Password** → enable the first switch → **Save**.
   * Tab **Users** → **Add user** → your email + a password. Repeat for Andreea's email.
     (There is no public sign-up page, so nobody else can create an account.)
4. **Create the database**
   * Left menu **Build → Firestore Database → Create database**.
   * Pick a location close to you (e.g. `europe-west`), start in **production mode** → **Create**.
   * Open the **Rules** tab, replace everything with the contents of `firestore.rules`,
     **put your two real email addresses in it**, then **Publish**.
     This is what keeps the data private to the two of you.
5. **Get the web config**
   * Click the gear ⚙︎ next to *Project overview* → **Project settings**.
   * Under **Your apps** click the web icon **`</>`**, give it a nickname, **Register app**
     (no need for Firebase Hosting).
   * Copy the `firebaseConfig = { … }` values into **`firebase-config.js`** in this folder.

## 2. Put the app on GitHub Pages (about 5 min)

1. On <https://github.com/new> create a repository, e.g. `srilanka-2027`. It must be **Public**
   for free GitHub Pages. That's fine: the code contains no personal data, and the trip data
   lives in Firebase behind your login.
2. Click **uploading an existing file** and drag in:
   `index.html`, `styles.css`, `app.js`, `firebase-config.js`, `firestore.rules`, `README.md`
   → **Commit changes**.
   ⚠️ Do **not** upload `trip-data.json`: it contains your booking reference and e-ticket numbers.
3. Repository **Settings → Pages** → *Source*: **Deploy from a branch** → branch **main**, folder **/ (root)** → **Save**.
   After a minute the page shows your address, e.g. `https://YOURNAME.github.io/srilanka-2027/`.
4. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain** →
   `YOURNAME.github.io`.

## 3. First use

1. Open the address and sign in.
2. You'll see a **Welcome** screen → **Import starter file** → choose `trip-data.json`.
   This loads your Qatar Airways flights, e-tickets and the arrival/departure entries in the calendar.
3. You'll be asked who you are (Bram / Andreea) so changes show who made them.
4. Send the link to Andreea. On a phone, use **Share → Add to Home Screen** for an app icon.

## Sections

| Section | What it does |
|---|---|
| Overview | Countdown, budget vs target, next preparation steps, things still to book, open topics |
| Flights | PNR, e-tickets, all four Qatar segments, flight cost (feeds the budget) |
| Calendar | 12–26 Jan, one card per day: locations, stays (with nights), activities, travel, food. Status *Tentative / To book / Booked / Paid / Done*, cost in EUR or USD, linked contact |
| Map | Calendar entries with a map pin, numbered in trip order and joined as a route; filter by day; unscheduled ideas in grey |
| Budget | Rolls up flights + calendar costs + extra lines; by category, by status, per day, per person, against a target. USD converted at an editable rate |
| Packing | Quick-add, per person or shared, tick when packed, filters, optional starter list |
| Preparation | Tasks with due dates grouped month by month up to departure, overdue flags, optional suggested plan |
| Ideas | Wishlist with ❤️ per person; "Add to calendar" turns an idea into a calendar entry |
| Contacts | Call / WhatsApp / email buttons; contacts can be linked to calendar entries |
| Documents | Passports, ETA, insurance, vaccinations per person; warns if a passport expires within 6 months of return |
| To discuss | Open topics and decisions |

**Map pins:** when adding or editing an entry, type a place (e.g. "Ella" or "Hiriketiya") and press **Find**, then pick the right result.

**Backup:** Settings → *export all data* downloads a JSON copy any time.

**Offline:** the app keeps a local copy, so you can open it with poor signal; edits sync when you're back online.

## Updating the app later
Edit a file on GitHub (pencil icon) or upload a new version. Data is unaffected.
