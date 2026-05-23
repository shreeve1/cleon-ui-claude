# Claims Registry

Track important factual claims that need explicit provenance.

| ID | Claim | Source | Page | Confidence | Status | Notes |
|----|-------|--------|------|------------|--------|-------|

Claim IDs use the next available zero-padded integer in `C-0001` format. Before adding claims, scan existing `C-####` IDs in this file, find the maximum, and increment by one for each new claim.

## Status Values

- `active`: current claim.
- `candidate`: claim tied to an unpromoted candidate page.
- `contradicted`: claim conflicts with another cited claim.
- `superseded`: claim has been replaced; notes must point to newer claim ID.
