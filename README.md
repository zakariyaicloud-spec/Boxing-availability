# Boxing availability

Checks clinic booking pages a few times a day and publishes free BCR1 medical slots for boxingmedicals.co.uk.

- `scripts/discover.js`: one-off discovery run that records how each clinic's booking page loads its times.
- `.github/workflows/discover.yml`: runs the discovery from the Actions tab ("Run workflow").
