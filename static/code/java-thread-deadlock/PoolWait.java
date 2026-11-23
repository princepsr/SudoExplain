// No lock is involved here, yet the program hangs: the only worker
// thread waits for a task that can never start.
// Run: java PoolWait.java   (stop it with Ctrl+C)
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public class PoolWait {
    public static void main(String[] args) {
        ExecutorService pool = Executors.newFixedThreadPool(1);   // one worker
        pool.submit(() -> {
            Future<String> inner = pool.submit(() -> "inner result");
            return inner.get();    // waits for a worker that is never free
        });
    }
}
