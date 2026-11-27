using System;

// Only Escape edges are observed. Injected input and key-repeat cannot stop a
// task, and no other keystroke is collected or retained.
public sealed class EscapeGesture {
    private bool down, stopped;
    private long previous = -1;
    public bool Observe(bool keyDown, bool injected, long milliseconds) {
        if (injected || stopped) return false;
        if (!keyDown) { down = false; return false; }
        if (down) return false;
        down = true;
        if (previous >= 0 && milliseconds >= previous && milliseconds - previous <= 650) {
            stopped = true; return true;
        }
        previous = milliseconds;
        return false;
    }
}
