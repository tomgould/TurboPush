# TurboPush Demo

A working upload page: pick files, watch per-file progress, pause, resume,
cancel, and retry failed files.

## Run it

From the project root:

```bash
npm install
npm run demo        # builds dist/ and starts php -S localhost:8000
```

Then open http://localhost:8000/demo/.

The page imports the built client from `dist/esm/TurboPush.js`, so run
`npm run build` again after changing `TurboPush.ts`.

## Files

- `index.html` - the upload form
- `demo.css` - the page's styles, on top of the design kit
- `demo.js` - demo logic, using the public API only
- `upload.php` - the demo endpoint
- `kit/` - the shared design kit: styles, theme switch scripts, fonts (with
  their licences) and icons, all local, so the page loads nothing from outside

## Where uploads go

`upload.php` stores finished files in `turbopush-demo/uploads` under the
system temp directory (usually `/tmp/turbopush-demo/uploads`), chunks in
`turbopush-demo/chunks`, and a log in `turbopush-demo/turbopush.log`.
Nothing is written inside the project.

## Options on the page

- **Simulate failures** adds `?simulateFailures=1` to the endpoint URL. The
  demo endpoint then answers the first attempt of chunks 1, 5, 9, ... with
  a 503, and the event log shows the client retrying with backoff.
- **Resume after reload** turns on the `resumable` option. Start a large
  upload, reload the page, pick the same file again and upload: only the
  missing chunks are sent.

PHP's built-in server uses your CLI `php.ini`. The demo uses 1MB chunks,
which fits PHP's default `upload_max_filesize` of 2MB.
