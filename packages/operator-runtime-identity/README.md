# Runtime source identity

Node and PowerShell compute the same bounded digest of application-root JavaScript modules and package declarations. Capture the Node value once at process startup; a launcher compares it with current disk bytes after verifying process ownership. A changed, added or removed helper requires a restart even when the entry point is unchanged.

This supplements the entry-point hash and PID/start-time checks. It is freshness evidence, not authentication. Browser assets have their own live freshness policy. Installed third-party dependency integrity remains the responsibility of the release manifest and package installation; this digest does not inspect every dependency beneath node_modules. Environment files and credentials are excluded.
