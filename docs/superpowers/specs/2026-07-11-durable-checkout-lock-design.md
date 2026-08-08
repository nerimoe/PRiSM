# Durable Checkout Lock

Checkout uses a D1-backed, per-player lease instead of relying solely on a Worker memory lock. A request atomically acquires a `checkout_locks` row before it reads sessions or writes balances. A concurrent request receives `CHECKOUT_IN_PROGRESS` and cannot create a second settlement.

Each lease has a unique lock ID and a one-minute expiry. Completion and errors release only the matching lock ID, preventing an expired request from deleting a newer request's lock. The lock is applied to ordinary checkout and staff override checkout.
