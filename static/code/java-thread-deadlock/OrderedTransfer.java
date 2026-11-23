// Fix 1: every thread takes the lower account id first.
// Run: java OrderedTransfer.java
public class OrderedTransfer {
    record Account(int id) {}

    static final Account A = new Account(1);
    static final Account B = new Account(2);

    public static void main(String[] args) throws Exception {
        Thread t1 = new Thread(() -> transfer(A, B), "transfer-1");
        Thread t2 = new Thread(() -> transfer(B, A), "transfer-2");
        t1.start();
        t2.start();
        t1.join();
        t2.join();
        System.out.println("done");
    }

    static void transfer(Account from, Account to) {
        Account first = from.id() < to.id() ? from : to;
        Account second = first == from ? to : from;
        synchronized (first) {
            pause(200);                  // stands in for real work
            synchronized (second) {
                System.out.println(Thread.currentThread().getName() + " finished");
            }
        }
    }

    static void pause(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
