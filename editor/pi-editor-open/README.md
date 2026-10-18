# Pi Reference Support

Opens a file and selects a line span when Pi asks. The file opens only in the window whose workspace folder is the Pi session folder.

Each window listens on `127.0.0.1` and writes its port and folders to `~/.pi/editor-open/windows/<pid>.json`.

```
POST /open
{ "folder": "<session cwd>", "file": "<absolute path>", "startLine": 21, "endLine": 32 }
```

Lines are 1-based and inclusive. `endLine` may be omitted. A window that does not have that folder returns `{ "opened": false }` and does not open the file.

Command: **Pi Reference Support: Show Window**.
