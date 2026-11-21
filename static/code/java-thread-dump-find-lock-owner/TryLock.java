import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

public class TryLock {
    static final ReentrantLock LOCK = new ReentrantLock();

    static void work() {
        System.out.println("got the lock");
    }

    public static void main(String[] args) throws Exception {
        // a slow owner holds the lock for 5 seconds
        Thread owner = new Thread(() -> {
            LOCK.lock();
            try {
                Thread.sleep(5000);
            } catch (InterruptedException e) {
                // stop sleeping when interrupted
            } finally {
                LOCK.unlock();
            }
        }, "git-loader");
        owner.start();
        Thread.sleep(200);

        long start = System.currentTimeMillis();
        // wait at most 1 second for the lock
        if (LOCK.tryLock(1, TimeUnit.SECONDS)) {
            try {
                work();
            } finally {
                LOCK.unlock();
            }
        } else {
            long ms = System.currentTimeMillis() - start;
            System.out.println("gave up after about "
                + (ms / 100) * 100 + " ms");
        }
        owner.interrupt();
        owner.join();
    }
}
