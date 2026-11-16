public class SlowLock {
    static final Object LOCK = new Object();

    static void work(long ms) {
        synchronized (LOCK) {
            try {
                Thread.sleep(ms);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    static Thread start(String name, long ms) {
        Thread t = new Thread(() -> work(ms), name);
        t.start();
        return t;
    }

    public static void main(String[] args) throws Exception {
        // takes the lock and holds it for ten minutes
        start("git-loader", 600_000);
        Thread.sleep(300);
        // each needs the lock for 1 ms, but must wait for it
        start("npm-registry", 1);
        start("build-manager", 1);
        start("hardware-check", 1);
        Thread.sleep(600_000);
    }
}
