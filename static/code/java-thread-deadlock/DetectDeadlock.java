// Starts the same opposite-order transfers as Deadlock.java and
// asks the JVM, from inside the program, whether threads are deadlocked.
// Run: java DetectDeadlock.java
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;

public class DetectDeadlock {
    static final Object ACCOUNT_A = new Object();
    static final Object ACCOUNT_B = new Object();

    public static void main(String[] args) throws Exception {
        start("transfer-1", ACCOUNT_A, ACCOUNT_B);
        start("transfer-2", ACCOUNT_B, ACCOUNT_A);
        Thread.sleep(1000);

        ThreadMXBean threads = ManagementFactory.getThreadMXBean();
        long[] ids = threads.findDeadlockedThreads();   // null when none
        if (ids == null) {
            System.out.println("no deadlock");
            return;
        }
        for (ThreadInfo info : threads.getThreadInfo(ids)) {
            System.out.println(info.getThreadName() + " waits for a lock held by "
                    + info.getLockOwnerName());
        }
    }

    static void start(String name, Object from, Object to) {
        Thread t = new Thread(() -> {
            synchronized (from) {
                pause(200);                  // stands in for real work
                synchronized (to) {
                    System.out.println(name + " finished");
                }
            }
        }, name);
        t.setDaemon(true);                   // lets this demo exit
        t.start();
    }

    static void pause(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
