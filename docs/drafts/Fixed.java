public class Fixed {
    static final Object LOCK = new Object();
    static int started = 0;

    static void work(long ms) {
        try {
            // slow part: no lock is held
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        // short part: the lock is held for a moment
        synchronized (LOCK) {
            started++;
        }
    }

    public static void main(String[] args) throws Exception {
        String[] names = {"git-loader", "npm-registry",
                          "build-manager", "hardware-check"};
        Thread[] ts = new Thread[4];
        for (int i = 0; i < 4; i++) {
            ts[i] = new Thread(() -> work(2000), names[i]);
            ts[i].start();
        }
        Thread.sleep(500);
        for (Thread t : ts) System.out.println(t.getName() + " " + t.getState());
        for (Thread t : ts) t.join();
        System.out.println("all finished, started=" + started);
    }
}
