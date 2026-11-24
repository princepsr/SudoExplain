import java.util.concurrent.*;

// Service A has 4 request threads and calls service B.
// B is slow: every call takes 2 seconds.
// 4 requests arrive every second for 3 seconds.
// At 2 seconds a health check arrives. It needs nothing from B.
//
// Run: java CascadeDemo.java           (no timeout)
//      java CascadeDemo.java timeout   (give up on B after 300 ms)
public class CascadeDemo {
    public static void main(String[] args) throws Exception {
        boolean useTimeout = args.length > 0;
        ExecutorService requestThreads = Executors.newFixedThreadPool(4);
        ExecutorService netB = Executors.newCachedThreadPool();
        long start = System.currentTimeMillis();

        for (int i = 1; i <= 12; i++) {
            int id = i;
            long arrived = System.currentTimeMillis();
            requestThreads.submit(() -> {
                Future<?> call = netB.submit(() -> sleep(2000));
                try {
                    if (useTimeout) call.get(300, TimeUnit.MILLISECONDS);
                    else call.get();
                } catch (Exception e) {
                    call.cancel(true);
                }
                System.out.println("request " + id + " took "
                        + (System.currentTimeMillis() - arrived) + " ms");
            });
            if (i == 8) {
                long arrivedHc = System.currentTimeMillis();
                requestThreads.submit(() -> System.out.println(
                        "HEALTH CHECK took "
                        + (System.currentTimeMillis() - arrivedHc)
                        + " ms"));
            }
            Thread.sleep(250);
        }
        requestThreads.shutdown();
        requestThreads.awaitTermination(60, TimeUnit.SECONDS);
        netB.shutdownNow();
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { }
    }
}
