import java.util.*;
import java.util.regex.*;

public class Triage {
    record Document(String doc, int version, String text) {}
    record Trace(String id, List<Document> documents,
                 List<String> toolResults, String answer) {}

    // the newest version of each document in the real system
    static final Map<String, Integer> CURRENT =
        Map.of("refund-policy", 4);
    static final Pattern ID = Pattern.compile("[A-Z]-\\d{4}");
    static final Pattern NUMBER = Pattern.compile("\\d+");

    static List<String> triage(Trace t) {
        // everything the model was shown
        StringBuilder shown = new StringBuilder();
        for (Document d : t.documents())
            shown.append(d.text()).append(' ');
        for (String r : t.toolResults())
            shown.append(r).append(' ');
        String seen = shown.toString();

        List<String> found = new ArrayList<>();
        // 1. IDs in the answer that the model was never shown
        Matcher id = ID.matcher(t.answer());
        while (id.find()) {
            if (!seen.contains(id.group()))
                found.add("invented ID: " + id.group());
        }
        // 2. documents that are not the newest version
        for (Document d : t.documents()) {
            int now = CURRENT.getOrDefault(d.doc(), 0);
            if (d.version() < now)
                found.add("old document: " + d.doc() + " v"
                    + d.version() + ", newest is v" + now);
        }
        // 3. numbers in the answer that no document contains
        String noIds = ID.matcher(t.answer()).replaceAll(" ");
        Matcher num = NUMBER.matcher(noIds);
        while (num.find()) {
            if (!seen.contains(num.group()))
                found.add("number not shown: " + num.group());
        }
        if (found.isEmpty())
            found.add("nothing found: send to the checker");
        return found;
    }

    public static void main(String[] args) {
        List<Trace> traces = List.of(
            new Trace("r-1",
                List.of(new Document("refund-policy", 3,
                    "Refunds are allowed within 90 days.")),
                List.of(),
                "Our policy allows refunds within 90 days."),
            new Trace("r-2",
                List.of(new Document("refund-policy", 4,
                    "Refunds: 30 days, unopened items only.")),
                List.of(),
                "You can return any item within 30 days."),
            new Trace("r-3",
                List.of(new Document("refund-policy", 4,
                    "Refunds: 30 days, unopened items only.")),
                List.of("orders: A-1001, A-1002"),
                "I have refunded order A-9999."));
        for (Trace t : traces)
            System.out.println(t.id() + " -> " + triage(t));
    }
}
