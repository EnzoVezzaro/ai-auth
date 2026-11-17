# Wallet recovery

## Create and store a wallet

Create a wallet with an agent name and a unique passphrase of at least 12 characters. The browser downloads `ai-auth-wallet-recovery.json`. Store that file offline, separate from your browser profile. Do not share it with a website or agent.

The file is protected with AES-GCM-256. The key is derived locally with PBKDF2-SHA-256 and a random salt. A wrong passphrase cannot unlock the file. AI Auth cannot reset the passphrase.

## Restore

Choose the recovery file in the wallet setup screen and enter its passphrase. The wallet checks that the recovered private key matches the public identity, then stores the key as a non-extractable Web Crypto key in IndexedDB.

## Remove local data

The Remove wallet action clears the stored key and signed activity from the current origin's IndexedDB. It does not delete downloaded recovery files or copies already received by peers. Recovery or rotation gives a new wallet id, so site links and grants must be approved again.
