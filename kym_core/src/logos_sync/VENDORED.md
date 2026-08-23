Vendored from github.com/vpavlin/logos-sync @ 0.3.0 (basecamp/logos_sync/), commit 730ddc2.
Do not edit here — change it upstream and re-vendor. See that repo's docs/adr/
for the design. These files are byte-for-byte copies of the upstream headers.
KYM uses event + merge + reconcile (RBSR); catchup.hpp is included for the future
v1 catch-up path. reconcile.hpp was itself lifted verbatim from KYM's original
kym_reconcile_std.hpp, so adopting it here is a pure de-duplication (docs/adr/0003).
What stays KYM's: the app types + the budget fold in kym_engine.hpp (logos-sync
ADR 0007/0010).
