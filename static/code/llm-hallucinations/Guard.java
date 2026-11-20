import java.util.Map;

public class Guard {
    record Order(String customerId, long totalCents,
                 boolean refundable) {}
    record Request(String orderId, long refundCents) {}

    static final Map<String, Order> ORDERS =
        Map.of("A-1001", new Order("c-7", 8000, true));
    // above this amount, a person must approve
    static final long AUTO_LIMIT_CENTS = 5000;

    static String guard(String customerId, Request req) {
        Order order = ORDERS.get(req.orderId());
        if (order == null)
            return "reject: order does not exist";
        if (!order.customerId().equals(customerId))
            return "reject: order belongs to someone else";
        if (!order.refundable())
            return "reject: order is not refundable";
        long cents = req.refundCents();
        if (cents <= 0)
            return "reject: bad amount";
        if (cents > order.totalCents())
            return "reject: refund exceeds order total";
        if (cents > AUTO_LIMIT_CENTS)
            return "needs approval: above the automatic limit";
        return "allow";
    }

    public static void main(String[] args) {
        String[][] tests = {
            {"c-7", "A-1001", "3000"},
            {"c-7", "A-9999", "3000"},
            {"c-9", "A-1001", "3000"},
            {"c-7", "A-1001", "7000"},
            {"c-7", "A-1001", "50000"},
        };
        for (String[] t : tests) {
            Request r = new Request(t[1], Long.parseLong(t[2]));
            System.out.println(t[0] + " " + t[1] + " " + t[2]
                + " -> " + guard(t[0], r));
        }
    }
}
