---
name: terminal-browser
description: A real browser running inside the terminal. It splits the human's terminal pane automatically, so you can show a website side by side with the conversation, render HTML to visualize something, and drive whatever tab is open — snapshot, click, fill, eval — with the `terminal-browser action` subcommand.
---

`terminal-browser open <url>` puts a browser in a terminal pane. On its own it
takes over the current pane. `--split right` (or `down`, `left`, `up`) opens a
new pane beside the human, which is how you show a page next to the
conversation. A path to a local html file works the same as a url, so writing a
page and opening it is a way to show something you built.

`terminal-browser ls` shows the browsers and tabs in this terminal tab, with the
tab ids the other commands take.

`terminal-browser --mirror` shows a tab from the browser the human already has
open, so the page keeps their logins and profile. It finds the browser itself
once the human has turned remote debugging on at `chrome://inspect/#remote-debugging`
and pressed Allow; nothing needs restarting or relaunching with flags. Tabs you
open from a mirroring pane are opened in their browser too, and closing the pane
lets go of the tab rather than closing it. `terminal-browser action` connects to
their browser separately, so the first automated command on a mirrored tab may
need one more Allow from them.

`terminal-browser action -- <command>` is an agent-browser compatible CLI for a
tab that is already open. It targets this terminal tab's browser and its active
tab unless you select another one.

When you use the terminal-browser action sub command, the user will visually
see in the browser tab an indication that you are acting on the browser tab. This
will automatically hide after a preset duration, where the countdown resets
everytime terminal-browser action is used. But its a much better experience
for the user if after the last time you plan to use terminal-browser action you
run terminal-browser action done, which immediately clears the indication
that you are using the browser tab

## Command reference
