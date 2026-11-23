// Fix 2: the same opposite-order transfers as Deadlock.java,
// but each thread gives up after 1 second instead of waiting forever.
// Run: java TryLockTransfer.java
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

public class TryLockTransfer {
    static final ReentrantLock LOCK_A = new ReentrantLock();
    static final ReentrantLock LOCK_B = new ReentrantLock();

    public static void main(String[] args) throws Exception {
        Thread t1 = new Thread(() -> run("transfer-1", LOCK_A, LOCK_B), "transfer-1");
        Thread t2 = new Thread(() -> run("transfer-2", LOCK_B, LOCK_A), "transfer-2");
        t1.start();
        t2.start();
        t1.join();
        t2.join();
    }

    static void run(String name, ReentrantLock from, ReentrantLock to) {
        try {
            System.out.println(name + (transfer(from, to) ? " finished" : " gave up"));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    static boolean transfer(ReentrantLock from, ReentrantLock to)
            throws InterruptedException {
        if (!from.tryLock(1, TimeUnit.SECONDS)) return false;
        try {
            Thread.sleep(200);           // stands in for real work
            if (!to.tryLock(1, TimeUnit.SECONDS)) return false;
            try {
                return true;             // move the money
            } finally {
                to.unlock();
            }
        } finally {
            from.unlock();
        }
    }
}
