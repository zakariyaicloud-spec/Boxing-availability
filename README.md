# Boxing availability

Checks clinic booking pages a few times a day and publishes free BCR1 medical slots for boxingmedicals.co.uk.

- `scripts/discover.js`: one-off discovery run that records how each clinic's booking page loads its times.
- `.github/workflows/discover.yml`: runs the discovery from the Actions tab ("Run workflow").
- `scripts/check.js`: the real checker. Reads each clinic's booking system and writes `availability.json`.
- `.github/workflows/check.yml`: runs the checker at 7am, 12pm, 5pm and 9pm (UK summer time).
- `availability.json`: published on GitHub Pages and read by the website.
- `debug/last-run.txt`: which clinics worked on the last run, and why any failed.
