# VISIONPOS internal Windows signing

`visionpos-internal-code-signing.cer` is the public half of the internal RSA
code-signing identity. It is safe to distribute to VISIONPOS-owned cashier
computers. The matching private key must remain outside Git.

Before installing VISIONPOS on a new cashier computer, open an elevated
PowerShell prompt from the trust-package directory and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-VISIONPOS-Cashier-Trust.ps1 -CertificatePath .\VISIONPOS-Cashier-Internal-Trust.cer
```

The script verifies the expected thumbprint and code-signing purpose before
installing the public certificate into the local machine's Trusted Root and
Trusted Publishers stores. It does not disable Smart App Control or Defender.

The release machine must retain the matching private key in
`Cert:\CurrentUser\My`. Back it up with:

```powershell
npm run signing:backup
```

Build a signed release from that same Windows account with:

```powershell
npm.cmd run release:signed
```

This verifies the exact certificate and private key, loads the Tauri updater
key only for the build process, and restores the previous process environment.

Never commit or upload a `.pfx`, `.p12`, password, or private-key file.
