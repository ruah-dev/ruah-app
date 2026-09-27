# Consumer app journey templates: fintech, e-commerce checkout, subscription apps, social/content

Scope note: these notes feed Ruah journey templates (persona -> goal -> steps with screen, action, why, signal). Each category below has sub-headings in the same order: Personas, Core journeys (with steps), Standard layout and its why, Drop-off points (with data), Signals. Published facts are under "Cited Findings", each with a source, date and population. Personas, journey steps and signals are mostly my own synthesis (under "Inferences"), because no single primary source publishes "standard journeys". Research date: 2026-09-27. About 18 search/fetch calls. Some figures were checked only at the search-snippet level; these are flagged "(snippet-level)".

---

## 1. Consumer fintech / mobile banking app

### Takeaway
Most banking-app use is about monitoring. Checking the balance or recent transactions is by far the most common task (94% of mobile-banking users, Fed 2015). That is why the balance and transaction list sit at the top of the home screen. Onboarding and KYC is where the biggest loss happens. Signicat's European surveys show that 38–68% of consumers abandoned a financial onboarding in the prior year, and the rate got worse between 2019 and 2022. Common causes were missing ID documents and requests for too much personal data.

### Cited Findings

**Standard layout and its why**
- Most common mobile-banking activities (US mobile-banking users, Fed survey fielded Nov 2015): checking balances or recent transactions 94%, transferring between own accounts 58%, receiving an alert from the bank 56% — [Federal Reserve, Consumers and Mobile Financial Services 2016, exec summary](https://www.federalreserve.gov/econresdata/mobile-devices/2016-executive-summary.htm)
- Alerts lead to action (same Fed survey): of users who got low-balance alerts, 36% deposited money and 43% transferred funds into the low account — [Federal Reserve 2016](https://www.federalreserve.gov/econresdata/mobile-devices/2016-executive-summary.htm)
- Later survey data also puts balance checking first (93% of mobile-banking users, reported as from the Fed 2022 survey), with about 45% paying bills in-app and about 32% checking balances daily (snippet-level; I could not confirm the original survey behind the aggregator) — [WalletHub Mobile Banking Statistics](https://wallethub.com/edu/mobile-banking-statistics/142803); [Flex blog](https://blog.flexcutech.com/blog/the-8-most-common-mobile-banking-activities-by-your-members)
- Monzo's home-screen redesign drew on input from more than 1,000 customers. The "main jobs" it prioritized were viewing balances, copying card details and searching transactions. The old app had "outgrown" its design, and customers could not see their full financial picture — [Monzo blog, "How we built the new Home screen"](https://monzo.com/blog/how-we-built-the-new-home-screen) (snippet-level; date not captured)
- Monzo puts a Card button on each account. It opens card details or lets the user freeze a lost or stolen card, which blocks card payments right away — [Monzo Help, home screen guide](https://monzo.com/ie/help/using-monzo/help-home-screen); [Monzo Help, finding features in new Home](https://monzo.com/help/app-help/finding-features-new-homescreen)
- J.D. Power 2025 US Banking Mobile App Satisfaction: national-bank apps scored 669/1,000 (+18 vs 2024) and credit-card apps 659 (+10). Basics such as fast log-in, modern look and easy navigation are now "somewhat homogenous". Customers who use multifactor authentication before log-in are 16 points more satisfied. Use of virtual assistants and satisfaction with them both fell — [J.D. Power press release, May 2025](https://www.jdpower.com/business/press-releases/2025-us-banking-and-credit-card-mobile-app-satisfaction-studies)

**Drop-off points (with data)**
- Signicat "Battle to Onboard" (European consumers, multi-country surveys). Abandonment was 40% in 2016 and 38% in 2019, then jumped to 63% in 2020 (up to 70% in some countries) and 68% in 2022. The 2022 figure is the highest since the series began — [Signicat press release 2022](https://www.signicat.com/press-releases/the-battle-to-onboard-2022); [Signicat, abandonment over the years](https://www.signicat.com/the-battle-to-onboard-2022/abandonment-to-financial-service-onboarding-over-the-years); [Fintech Times coverage](https://thefintechtimes.com/68-of-european-consumers-abandon-financial-applications-during-onboarding-finds-signicat/)
- Reasons for abandoning (Signicat, snippet-level): 21% said too much personal information was requested; 38% did not have the right identity credentials (passport, digital ID). Gen Z and people up to 44 are more likely to quit entirely if the process does not work as expected — [Signicat 2022 report page](https://www.signicat.com/the-battle-to-onboard-2022); [Innovatrics summary of 63% figure](https://innovatrics.com/trustreport/63-of-customers-abandon-digital-bank-onboarding-is-biometrics-the-solution/)
- Note: the survey measures self-reported "abandoned at least one application in the past year". It does not measure a funnel conversion rate.

**Signals**
- J.D. Power says MFA use before log-in correlates with +16 satisfaction points. This suggests that secure log-in, when done well, is a satisfaction driver and not only friction — [J.D. Power 2025](https://www.jdpower.com/business/press-releases/2025-us-banking-and-credit-card-mobile-app-satisfaction-studies)

### Inferences

**Personas (2–3)**
1. *Everyday spender / salary earner*: checks the balance several times a week, pays friends, wants control over surprises. Goal: "Know what I can spend and never get caught out."
2. *New-to-bank switcher / digital native (Gen Z–44)*: opening an account only on mobile, has low patience with document friction (Signicat age finding). Goal: "Have a working account and card today."
3. *Anxious / security-focused user*: worried about fraud, lost cards, scams. Goal: "Stop bad things fast and get reassurance."

**Core journeys (screen -> action -> why -> signal)**
1. *Onboarding + KYC*: Welcome/value screen -> tap "Open account" -> phone/email + OTP -> personal details (minimum fields) -> ID document capture -> selfie/liveness -> address/tax questions -> review + consent -> account ready and virtual card issued -> prompt to add money and set up Apple/Google Pay.
   - Why: ask for the ID document only after the user has committed to signing up. Tell users up front which documents they need (38% abandon for lack of credentials). Issue a virtual card right away so they get value immediately.
   - Signal: KYC pass rate, time to account open, step-level drop-off, first funding within 24h.
2. *Check balance / recent activity*: open app -> biometric log-in -> home shows available balance plus latest transactions -> tap a transaction for merchant, category and map.
   - Why: this is the #1 task (94%), so it needs zero taps after log-in.
   - Signal: time from launch to balance visible; sessions per week.
3. *Send transfer / P2P*: Home -> "Pay/Send" primary action -> choose or search payee (recents first) -> amount -> reference -> confirm screen (payee name check, fee, arrival time) -> biometric/SCA -> success receipt plus share.
   - Why: the confirm screen and payee check prevent mistakes and fraud; recents cut repeat effort.
   - Signal: transfer success rate, errors/cancels at confirm, repeat payees.
4. *Pay a bill / scheduled payment*: Payments tab -> add biller or scan bill -> amount and date -> confirm -> reminder or recurring option.
   - Signal: on-time payments, recurring setup rate.
5. *Freeze / unfreeze card*: Home -> Card -> "Freeze" toggle (one tap, reversible) -> confirmation state -> optional "Report lost/stolen" and reissue.
   - Why: a reversible freeze lowers panic and support calls, and people use it in stressful moments.
   - Signal: time to freeze; support contacts after a freeze; unfreeze rate (a false alarm resolved by the user).
6. *Alerts and insights*: push on every transaction or low balance -> tap -> transaction detail -> action (top up or transfer).
   - Why: the Fed data shows alerts trigger deposits and transfers.
   - Signal: alert tap rate, actions taken after an alert.

**Standard layout and its why (synthesis)**
- Balance at the top with recent transactions below: monitoring is the dominant task.
- Two or three primary actions (Pay, Add money, Card): these are the next most frequent tasks.
- Card controls on the home screen: stressful, time-critical moments need to be one tap away.
- Biometric log-in: makes security feel easy (the J.D. Power MFA finding).

### Gaps
- I found no public neobank-specific funnel numbers (Revolut, Nubank, Chime KYC pass rates). Monzo and Revolut engineering blogs were not fetched in depth.
- No Baymard or NN/g banking-specific stats were retrieved. NN/g has banking UX reports, but I did not fetch them.
- Up-to-date (2024+) Fed activity percentages are not verified at the primary source; the 94/58/56 figures come from Nov 2015 data.

---

## 2. E-commerce checkout

### Takeaway
Across 50 studies the average cart abandonment rate is about 70%. Among shoppers who meant to buy, the top reason is extra costs discovered late (40%). Slow delivery, security concerns, forced account creation and long checkouts follow. Baymard's standard checkout pattern follows from these reasons: prominent guest checkout, total cost shown early, about 7–8 fields, and trust signals. Baymard estimates that better checkout design could raise conversion by about 35% for large sites.

### Cited Findings

**Drop-off points (with data)**
- Average documented cart abandonment is 70.22%, averaged from 50 studies — [Baymard, Cart Abandonment Rate list, updated Sep 22 2025](https://baymard.com/lists/cart-abandonment-rate)
- Reasons for abandoning at checkout, among US shoppers who were not "just browsing" (Baymard survey, 2025 edition): extra costs too high (shipping, tax, fees) 40%; delivery too slow 20%; did not trust the site with card info 19%; site wanted me to create an account 18%; checkout too long or complicated 17%; site errors or crashes 17%; unsatisfactory returns policy 13%; could not see total cost up front 12%; card declined 10%; not enough payment methods 9% — [Baymard](https://baymard.com/lists/cart-abandonment-rate)
- Conflict note: several secondary sources quote older Baymard survey editions: unexpected costs 48%, forced account 24–26%, too many fields 21%, security 25%. Always record the survey year — [Growthegy summary](https://www.growthegy.com/2026/05/26/cart-abandonment-science-why-customers-leave-checkout/); [Baymard, reduce cart abandonment](https://baymard.com/blog/reduce-cart-abandonment)
- Mobile abandonment is reported at 85.65% vs desktop 73.07% (secondary aggregator, snippet-level) — [Baymard list via search](https://baymard.com/lists/cart-abandonment-rate)
- About 42% of US shoppers abandon because they were "just browsing". Baymard excludes this group from the reasons chart — [Baymard](https://baymard.com/lists/cart-abandonment-rate)

**Standard layout and its why**
- Ideal checkout has about 12–14 form elements (7–8 fields). The average US checkout shows 23.48 form elements by default — [Baymard](https://baymard.com/lists/cart-abandonment-rate)
- About a 35% conversion increase is possible for large e-commerce sites from checkout design alone. That is roughly $260B in recoverable orders across the US and EU — [Baymard](https://baymard.com/lists/cart-abandonment-rate)
- Guest checkout should be the most prominent option, at the top of the account-selection step and within the first viewport. If users miss it, the result is as bad as not offering it. Figures on sites that fail this vary: 47% (benchmark) vs 62% (older figure) — [Baymard, Make Guest Checkout Prominent](https://baymard.com/blog/make-guest-checkout-prominent); [Baymard checkout flow guide](https://baymard.com/blog/checkout-flow-ux-optimization)

### Inferences

**Personas**
1. *Decided buyer (mission shopper)*: knows the item and wants the fastest path. Goal: "Pay and get a delivery date in under 2 minutes."
2. *Price/cost-sensitive comparer*: adds to cart to see the total and leaves if the final price shocks them. Goal: "Know the full price, including shipping, before committing."
3. *Returning loyal customer*: has an account and saved payment. Goal: "Reorder in a few taps."

**Core journeys**
1. *Product page -> add to cart*: PDP (images, price, variant picker, delivery estimate, returns summary) -> select variant -> "Add to cart" -> confirmation (mini-cart or toast with "Checkout" and "Continue shopping").
   - Why: showing the delivery estimate and returns policy on the PDP answers the reasons ranked #2 (slow delivery 20%) and returns (13%) before checkout starts.
   - Signal: add-to-cart rate per PDP view.
2. *Cart review*: Cart shows line items, quantity edit, subtotal, estimated shipping, tax and promo field (collapsed) -> "Checkout".
   - Why: showing the full cost early addresses the #1 reason (40%) and "couldn't calculate total" (12%). Collapse the promo field so it does not send people off hunting for coupons.
   - Signal: cart-to-checkout rate.
3. *Checkout (guest-first)*: account step with "Guest checkout" on top -> contact (email) -> shipping address (autocomplete, about 7–8 fields in total) -> delivery method with dates -> payment (wallets such as Apple/Google Pay first, then card, with trust badges) -> review order with total -> "Place order".
   - Why: forced accounts (18%), long checkouts (17%) and security doubts (19%) are each known abandonment reasons.
   - Signal: checkout-start-to-order rate, field error rate, payment decline rate (10% reason).
4. *Confirmation and post-purchase*: confirmation page (order number, delivery date, summary) -> optional "Save your details as an account" (password only) -> confirmation email -> shipping updates.
   - Why: offering account creation after purchase keeps guest speed and still converts some guests to accounts.
   - Signal: post-purchase account creation, WISMO (where-is-my-order) support contacts.
5. *Returning customer express reorder*: sign in or passkey -> saved address and payment prefilled -> one-page review -> place order.
   - Signal: repeat purchase rate, time to order.
6. *Cart recovery*: exit with items in cart -> reminder email or push -> return to a persisted cart.
   - Signal: recovered-cart rate.

### Gaps
- I did not fetch Baymard's specific per-guideline stats on address autocomplete, the "delivery speed" display, or mobile checkout benchmark percentages. These are mostly behind the paywall.
- The mobile vs desktop abandonment split is from a search snippet only.

---

## 3. Subscription mobile app (fitness, meditation, language learning)

### Takeaway
The first session decides monetization. About 80–90% of trial starts and roughly half of paid conversions happen on Day 0, and 55% of 3-day-trial cancellations also happen on Day 0. That is why the standard pattern is a short personalization questionnaire, then a value preview or "your plan", then a paywall at the end of onboarding. Hard paywalls convert about 5x better than freemium (10.7% vs 2.1% median). Retention after that is built with habit mechanics. At Duolingo, streaks, streak-saver notifications and leagues raised the Current User Retention Rate (CURR) 21% and grew DAU 4.5x.

### Cited Findings

**Drop-off points / paywall timing (with data)**
- RevenueCat State of Subscription Apps 2026 (115,000+ apps, $16B+ revenue; published Mar 19 2026, by Lorelei Whitman). Median download-to-paid by Day 35: hard paywall 10.7% vs freemium 2.1%. Trial-to-paid median: 42.5% for 17–32-day trials vs 25.5% for trials under 4 days — [RevenueCat blog, 2026 benchmarks](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)
- RevenueCat 2026: 55.4% of 3-day-trial cancellations happen on Day 0 (up from about 51% in 2025), and 84% happen by Day 1. 35% of annual-plan cancellations happen in month 1. Google Play involuntary (billing) churn is 31% of cancellations vs 14% on the App Store — [RevenueCat 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)
- RevenueCat: 80–90% of trials start on Day 0, and about 50% of paid conversions happen on Day 0 (report-level summary, snippet) — [RevenueCat State of Subscription Apps](https://www.revenuecat.com/state-of-subscription-apps)
- Adapty State of In-App Subscriptions 2026 (16,000 apps, $3B revenue, 10,000+ paywalls). Global install-to-trial 10.9%, trial-to-paid 25.6%. Health & Fitness has the highest trial-to-paid at 35.0% and Entertainment the lowest at 19.1%. 89.4% of trial starts happen on Day 0. Trial subscribers retain 1.4–1.7x better than direct buyers — [Adapty report](https://adapty.io/state-of-in-app-subscriptions/)
- Conflicting or unclear figures: a secondary summary says Adapty found missing the first session drops the chance of ever trialing to 11%, and cites 44.5% of purchases on Day 0 and a 53% average trial-to-paid. These do not match Adapty's own 25.6% headline. Treat them as unverified — [RocketShip HQ summary](https://www.rocketshiphq.com/adapty-subscription-app-benchmark-2025-summary/). Adapty's "onboarding paywall without trial converts 37.45%" appears on the report page without a clear denominator; do not use it without checking.

**Habit loops and streaks**
- Jorge Mazal (former Duolingo CPO), "How Duolingo reignited user growth", Lenny's Newsletter, Feb 28 2023. Duolingo's growth model sorts users into new, current, reactivated (7–29 days away), resurrected (30+), at-risk WAU, at-risk MAU and dormant. CURR had about 5x more impact on DAU than the next-best lever. Over about 4 years CURR rose 21%, daily churn of engaged users fell 40%+, and DAU grew 4.5x — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth)
- Same source: leaderboards/leagues raised learning time 17% and tripled highly engaged learners. Streaks became the strongest engagement mechanic. Streak-saver notifications protected streaks. Users on 7+ day streaks roughly tripled as a share and passed 50% of DAU. Notification optimization protected the channel against opt-out. Failed experiments: a Gardenscapes-style moves counter had no retention impact, and an Uber-style referral program added only about 3% new users — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth)
- A secondary source says reaching a 10-day streak greatly reduces a learner's chance of dropping off (secondary, not verified at primary) — [Lenny's "secret to Duolingo's growth"](https://www.lennysnewsletter.com/p/the-secret-to-duolingos-growth)

### Inferences

**Personas**
1. *Motivated starter*: just made a resolution (get fit, learn Spanish for a trip). High intent on Day 0, fragile by week 2. Goal: "Start a plan that fits me and stick with it."
2. *Price-skeptical explorer*: wants to try before paying and cancels trials quickly (the Day 0 cancellation data). Goal: "See if it's worth it without being tricked."
3. *Lapsed returner*: had a streak or a plan and fell off (Duolingo's reactivated/resurrected states). Goal: "Get back in without shame or starting over."

**Core journeys**
1. *Onboarding questionnaire -> personalized plan*: splash -> goal ("Why are you here?") -> level / experience -> daily time commitment -> optional motivators or notification-time pick -> "Building your plan…" -> plan summary screen.
   - Why: building commitment and personalization before asking for money raises perceived value (standard industry pattern; no primary A/B data retrieved).
   - Signal: questionnaire completion rate, time to plan.
2. *First value moment (before or after sign-up)*: a first lesson, workout or meditation is completed right away, often before account creation (gradual engagement) -> celebration -> streak day 1.
   - Signal: % of installs completing the first core action on Day 0.
3. *Paywall and trial start*: paywall at the end of onboarding (Day 0) -> plan options with annual highlighted and trial timeline ("Today: full access; Day X: reminder; Day Y: billed") -> start trial with the platform purchase sheet -> confirmation.
   - Why: about 90% of trials start on Day 0. A transparent trial timeline speaks to the price-skeptical persona, and hard paywalls convert about 5x better.
   - Signal: install-to-trial (benchmark about 10.9%), paywall view-to-trial, Day 0 cancellation rate.
4. *Daily habit loop*: reminder push at the chosen time -> open straight to today's session -> complete -> streak increments, XP/league update -> tease tomorrow.
   - Why: this is the Hooked-style trigger -> action -> variable reward -> investment loop. Duolingo's streak data shows it moves retention.
   - Signal: D1/D7/D30 retention, CURR, share of DAU on a 7+ day streak.
5. *Trial-to-paid conversion / renewal*: trial reminder before billing (sometimes required by platform policy) -> value recap ("You've done 9 workouts") -> auto-convert.
   - Signal: trial-to-paid (benchmark 25.6% overall; 35% Health & Fitness); billing-retry recovery.
6. *Win-back / streak repair*: at-risk push ("Your streak is at risk") or streak freeze -> return; resurrected users get a lighter re-onboarding.
   - Signal: reactivation and resurrection rates (Duolingo state model).

**Standard layout and its why**
- Paywall after the questionnaire, not at first launch: the user has invested effort and seen a personalized plan, and it is still Day 0, which is when trial starts cluster.
- Home screen centered on "today": one primary CTA (today's session), with the streak counter visible so there is something to lose.

### Gaps
- I did not fetch Nir Eyal's *Hooked* (2014) primary material. The four-step model (trigger, action, variable reward, investment) is well known but not cited here from a fetched page; see nirandfar.com.
- No primary A/B data on questionnaire length vs conversion was retrieved.
- Category-specific data for Education/language apps is missing from both reports' public summaries.

---

## 4. Social / content app

### Takeaway
Social apps face a cold-start problem. A new user's feed and graph are empty, so onboarding gets them to an "atomic network" or a personalized feed fast. It does this with interest/topic selection or contact import, then a feed that is already populated, and only later asks them to post. Most users will only consume (NN/g 90-9-1), so templates need separate creator and consumer journeys. Pinterest found that shorter onboarding and moving extra questions after sign-up improved activation.

### Cited Findings

**Personas / participation**
- Participation inequality: roughly 90% of users lurk, 9% contribute occasionally, and 1% contribute most content. Blogs skew further (about 95-5-0.1). Wikipedia had more than 99% lurkers. First studied by Will Hill (Bellcore, early 1990s) — [Jakob Nielsen, NN/g, "Participation Inequality: The 90-9-1 Rule" (2006)](https://www.nngroup.com/articles/participation-inequality/)

**Cold start**
- Andrew Chen's *The Cold Start Problem* defines the atomic network as the smallest network that can stand on its own. Slack works with fewer than 10 people in one company. Tactics include launching in the simplest form, building tiny dense networks first, and invite-only launches — [Lenny Rachitsky, "The Atomic Network" (Dec 9 2021), excerpt of Chen](https://www.lennysnewsletter.com/p/atomic-network)
- Facebook activation rule: a search summary of Chen's material gives it as "10 friends in 7 days". The widely quoted version is "7 friends in 10 days". Treat the exact numbers as uncertain and check the book before quoting — [Sachin Rekhi, primer on Cold Start Problem](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem)

**Onboarding (Pinterest)**
- Pinterest found that asking for gender during sign-up confused users and caused sign-up drops. Moving it into post-signup onboarding improved activation. Localized interest options for international users improved activation abroad by 5–10% depending on country — [Pinterest Engineering, "Exploring effective user signals" (Sophia Feng)](https://medium.com/pinterest-engineering/exploring-effective-user-signals-585507d8e926)
- Pinterest kept onboarding to a few steps (topic selection, plus a browser-extension step) because users dropped off in longer flows. Topic picking takes users straight to a personalized home feed — [Appcues/Ty Magnin, "Casey Winters reveals how Pinterest perfected user onboarding"](https://medium.com/appcues/casey-winters-reveals-how-pinterest-perfected-user-onboarding-639fcc7486d7); [GoodUX, Pinterest's value-driven onboarding](https://goodux.appcues.com/blog/pinterests-value-driven-onboarding-flow)
- Interests chosen in onboarding skewed toward dominant interests and did not change with behavior, which led Pinterest to newer "Pinner progression" work (Jul 2026) — [Pinterest Engineering, Pinner Progression](https://medium.com/pinterest-engineering/pinner-progression-better-use-case-representation-driving-weekly-active-user-growth-at-pinterest-bd2131ab238a) (snippet-level)

### Inferences

**Personas**
1. *Consumer / lurker (about 90%)*: wants entertainment or inspiration and rarely posts. Goal: "Find stuff I like within seconds."
2. *Casual contributor (about 9%)*: comments, reacts, shares, posts occasionally. Goal: "Connect with friends or community and get some response."
3. *Creator (about 1%, the "hard side")*: publishes regularly and cares about reach and tools. Goal: "Grow an audience with minimal effort."

**Core journeys**
1. *Sign-up -> interest / follow selection*: splash -> sign up (SSO or phone) -> minimal profile (name, handle) -> pick 3–5 topics or suggested accounts, and/or contact sync -> notification permission prompt, with context given first -> first feed.
   - Why: every question before sign-up costs conversions (Pinterest gender step), so extra signals come after sign-up. Topic picking fills the feed and avoids an empty state.
   - Signal: sign-up completion, topics selected, follows made in session 1.
2. *First feed / first value*: personalized feed loads with content (never empty) -> scroll -> like/save -> the feed adapts.
   - Why: the product must feel alive before a graph exists (cold start).
   - Signal: time to first like/save; D1 retention.
3. *Build graph (atomic network)*: "People you may know" / contact import / invite -> follow -> mutual follow.
   - Signal: reaching an activation threshold of N connections in the first days (the Facebook-style rule; calibrate per product).
4. *First post / creation (contributor and creator)*: "+" create -> capture or upload -> edit/templates -> caption, tags, audience -> post -> early feedback (likes/comments pushed as notifications).
   - Why: early feedback rewards the first post. Most users will never post, so this journey targets the 1–10%.
   - Signal: % of new users posting within 7 days, and feedback received on the first post.
5. *Notification re-engagement*: social push (someone followed, commented, a friend posted) -> deep link to the item -> engage.
   - Why: social notifications are the natural external trigger. Over-sending risks opt-out (Duolingo protected its notification channel for the same reason).
   - Signal: push opt-in rate, open rate, disable rate.
6. *Creator growth loop*: analytics/insights -> post again -> audience growth.
   - Signal: weekly posting creators, retention of creators.

**Standard layout and its why**
- The feed is home: most users consume.
- Create is the center tab or a floating "+": always reachable for the minority who create.
- The notification/activity tab is a feedback loop that brings people back.

### Gaps
- I retrieved no primary data on TikTok's or Instagram's onboarding (TikTok's interest-less, algorithm-first feed is commonly described but not cited here).
- The exact Facebook "friends in days" activation rule is unconfirmed at the primary source; there is a conflict over 7/10 vs 10/7.
- No published benchmark for push opt-in rates in social apps was retrieved.
