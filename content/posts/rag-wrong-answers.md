---
title: RAG wrong answers: why retrieval fails and how to fix it
date: 2026-11-01
description: Why a chatbot over your documents gives confident wrong answers, how bad chunks and missed retrieval cause it, and how to measure and fix each part.
tags: LLM, RAG
draft: true
---

## The question

You build a chatbot over your company's documents. In the demo, it answers a dozen questions perfectly. In production, users report that it quotes an old policy, mixes up two products, misses a document that clearly has the answer, and states all of it with complete confidence.

The model is a good one. Swapping it for a bigger model barely helps.

> The answer is in our documents. Why does the AI get it wrong?

Usually the model never **saw** the right text. It answered from whatever the search step handed it, and that search step went wrong.

> [!SUMMARY]
> By the end you will know:
>
> 1. How **RAG** works, and why the model can only be as good as the text it is given
> 2. Common failures: bad text and chunks, missed retrieval, stale indexes, wrong context size and no "I don't know"
> 3. How to **diagnose** by measuring retrieval separately from the answer
> 4. How to fix each, and where fixes backfire

## First, what RAG is

A **language model** is a program that predicts text, and chat assistants are built on one. It does not know your private documents. **Retrieval-augmented generation (RAG)** gives it the relevant ones at question time. Think of an open-book exam where a librarian fetches the pages and you answer from them. Where it stops: if the librarian fetches the wrong pages, you still write a confident answer.

1. **Prepare (once):** split each document into pieces called **chunks**. Turn each chunk into an **embedding**: a list of numbers that works like map coordinates, so chunks with similar meanings sit close together. Store them in an **index**, a store you can search by closeness (often called a vector database).
2. **Retrieve (per question):** embed the question the same way, and find the chunks whose embeddings are closest.
3. **Generate:** paste those chunks into the **prompt** (the text you send the model) and ask it to answer **using them**.

```pseudocode
chunks = search(embed(question), top = 5)     # the 5 closest chunks
prompt = "Answer using only this text:\n" + chunks + "\n\nQuestion: " + question
answer = model(prompt)
```

Everything depends on step 2. If the right chunk is not among the five, the model has little correct to work from, and it will still produce a fluent answer.

```diagram
type: flow
alt: A question is embedded, the closest chunks are found in the index, pasted into the prompt, and the model answers from them.
caption: Figure 1. The model only sees what search hands it. A bad search gives a confident wrong answer.
Question is embedded -> Search the index for chunks -> Wrong chunks come back -> Model answers confidently !
```

## The failures

**1. Bad text extraction.** Before chunking, the document is turned into plain text. PDFs and web pages often come out as garbage: headers and footers repeated on every page, tables flattened into a jumble, scanned pages with no text at all, menus and cookie banners mixed in. The search can only find what is readable.

**2. Chunks that cut the meaning.** A document is split into pieces of, say, 500 words. A refund policy says "Refunds are available within 30 days" in one chunk, and "except for opened software" in the next. The retrieved chunk is true and incomplete. A table split in half, or a chunk that lost its heading ("30 days" for *which* product?), does the same.

**3. Retrieval that misses.** Embeddings find text about the same **topic**, not necessarily the right one. A 2023 policy and a 2025 policy are close in meaning, so the old one can win. Embeddings are also often weak at exact terms such as error codes (`E-4012`), product IDs and names, which people search for constantly. In a chat, a follow-up like "what about the EU?" means nothing when embedded alone.

**4. A stale or leaky index.** Documents change, but the index still holds last quarter's chunks, so the bot answers from old text. Deleted documents stay answerable. Worse, if all chunks are searchable by everyone, a user can get an answer built from a document they should not see. This is [the access control problem](/posts/broken-access-control-idor/) again, in a new place.

**5. The wrong amount of context.** Too few chunks and the answer is missing. Too many and the answer is buried among distractions. In a 2023 study of the models of that time, information at the start and end of a long prompt was used better than the middle. Newer models may behave differently. Every chunk also costs tokens on every call (see [the cost post](/posts/llm-token-cost/)).

**6. No way to say "I don't know".** When the retrieved text is irrelevant, the model still answers, because that is what it does. Nothing in the pipeline tells it, or the user, that the search found nothing good.

## How to diagnose it

The key is to stop judging only the final answer. **Split the problem in two:** did retrieval find the right text, and did the model use it well?

**1. Log everything.** For each question, store the question, the chunks retrieved with their scores, the final prompt, and the answer. Without this, you are guessing.

**2. Read the chunks.** Print 20 random chunks and read them. If a chunk is unreadable to you, it is unreadable to the search.

**3. Build a small test set.** Collect 30 to 50 real questions, each with the document (or section) that should answer it. This takes an afternoon and pays back every week.

**4. Measure retrieval alone.** For each test question, check whether the correct document appears in the top results. This is called **recall at k** (here k is 5, the number of results you keep):

```pseudocode
hits = 0
for each (question, correctDoc) in testSet:
    results = search(embed(question), top = 5)
    if correctDoc in documentsOf(results):  hits += 1
recall_at_5 = hits / testSet.size
```

**5. Read the failures one by one.** If the right chunk was **not** retrieved, it is a search problem (text extraction, chunking, keywords, filters). If it **was** retrieved and the answer is still wrong, it is a prompt or model problem. This one split tells you where to spend your effort.

### See it yourself

Pick one question that your bot answers wrongly. Print the chunks it retrieved, with their scores, and read them as if you were the model. Most of the time you will see at once why the answer went wrong.

## Fix 1: clean the text, then chunk by meaning

Use a parser that understands layout, run OCR (text recognition) on scanned pages, and strip repeated headers, footers and menus. Then split on the document's own structure, such as headings and sections, not at a fixed length. Add a small **overlap** between chunks. Keep tables whole. Store the **title and heading path** with each chunk, and include them in the text you embed, so "30 days" arrives with "Software licenses > Refunds".

## Fix 2: search by keywords as well as meaning

Combine **semantic search** (embeddings) with **keyword search** (such as BM25, which scores exact word matches and favors rare words). This is called **hybrid search**. The two lists have scores on different scales, so merge them by rank, not by adding scores. A common method is reciprocal rank fusion, which gives each document 1/(60 + rank) from every list it appears in and adds the results.

The keyword half only finds `E-4012` if its tokenizer (the step that splits text into words) keeps the code in one piece. Many standard tokenizers break text at hyphens, so `E-4012` would be indexed as `E` and `4012`. Test how your analyzer treats codes.

Then **rerank**: a model reads the question and each chunk together and scores how well they fit. **Retrieve wide, keep narrow.** Fetch the top 30 to 50 chunks, rerank, and send only the best 3 to 5 to the model, with the strongest first (or at the start and end of the context). This is the fix for the wrong amount of context.

Use **metadata filters** to narrow the search before it starts: product, region, document version, date. Asking for "the current EU policy" should never compete with the 2023 US one.

For chat, **rewrite the question** into a standalone one using the conversation, so "what about the EU?" becomes "What is the refund policy for the EU?" before searching.

## Fix 3: keep the index current and respect permissions

Re-index a document whenever it changes, and **remove** its chunks when it is deleted. Store who may read each document, and **filter the search by the asking user's permissions** before any text reaches the model.

## Fix 4: let it say "not found"

Set a minimum relevance score. If nothing passes, return "I could not find this in the documents" instead of generating. Scores are not comparable across models or question types, so tune the threshold on your own test set. In the prompt, ask for **citations**, so each claim points to a source that a person can check, and tell the model to answer "not found" when the text does not contain the answer.

## When the fix goes wrong

Most of these are small. Three are easy to miss, because everything looks fine while they hurt you.

**1. Changing the embedding model.** An **embedding** is a list of numbers that stands for the meaning of a piece of text. Search works by comparing the numbers of the question with the numbers of each chunk. A better model comes out, and you start using it, maybe only for new documents.

The trouble is that each model builds its own number space. Position 7 in one model's list means something different from position 7 in another's. Numbers from two models cannot be compared. If the lists have different lengths, the comparison cannot even run. If they happen to match in length, it runs and quietly returns bad matches, with no error to warn you.

A mixed index is just as bad. Say 10,000 old chunks were made by model A and 500 new ones by model B. A question embedded with model B only compares sensibly with the 500.

Instead, build a second index, re-embed **every** chunk with the new model, and run your test set on it. Switch over only if it scores better, then delete the old index. Store the model name next to the vectors, so you always know which is which.

**2. A test set that is too easy.** You wrote 50 test questions by taking a sentence from each document and turning it into a question. The document says "The refund window for annual plans is 30 days", and your question is "What is the refund window for annual plans?" Both share the same words, so almost any search finds it. You score 50 out of 50 and ship.

Real users write "can I get my money back after a year?" There is no shared wording, and retrieval might find the right chunk for only 31 of 50 such questions (illustrative). The perfect score told you nothing.

Build the test set from real logs and support tickets, in the users' own words. For each question, note which chunk holds the answer. Then measure how often that chunk appears in the top 5 results.

**3. Invented citations.** You ask the model to cite its sources, and answers now arrive with "[3]" at the end. That looks trustworthy. But a model can cite a source that was never in the prompt, or attach a real source to a claim it does not support. Say you sent chunks 1 to 5 and the answer cites [7].

Check in code that every cited chunk was really among those you sent. Reject the answer, or retry, if not. This catches made-up sources only. It does not prove a source supports the claim, so show the cited passage next to the answer and let the reader check.

The smaller pitfalls, in short:

- **Bigger chunks.** Large chunks hold more context but blur the meaning, so they match many questions weakly. They also waste prompt space. Embedding models accept a limited input length, and text past it may be cut off, or the call may fail, so check your model's limit.
- **Too much overlap.** Duplicated text from neighboring chunks fills the top results with near copies of the same passage.
- **A threshold that is too strict.** The bot refuses to answer questions it could have answered. Tune it on your test set.
- **A reranker that is too slow.** It adds delay to every question. Rerank only the top 30 to 50.
- **Summarizing chunks to save space.** Summaries drop the details, such as numbers and exceptions, that people ask about.
- **Poisoned documents.** Retrieved text can hold hidden instructions. See [the prompt injection post](/posts/prompt-injection/).

## Which should you use?

| Situation | Reach for |
|---|---|
| Answers are garbled or full of page headers | **Clean text extraction** (layout-aware parser, OCR) |
| Answers cut off mid-policy | **Structure-aware chunks** with overlap and headings kept |
| Exact terms, codes and names are missed | **Hybrid search** (keywords plus embeddings) |
| The right chunk is found but the answer ignores it | **Fewer, reranked chunks,** best first |
| Follow-up questions fail in chat | **Rewrite the question** as a standalone one |
| Old and new versions compete | **Metadata filters** by version, region and date |
| Different users may see different documents | **Permission filter** in the search itself |
| Confident answers to unanswerable questions | **A relevance threshold,** citations and a "not found" answer |
| You cannot tell what is failing | **A test set and recall at k,** measured before and after each change |

If you are not sure where to start, build the test set. Every improvement after that is a measurement instead of an opinion.

## The takeaway

1. RAG is **search first, then a model**. If search returns the wrong text, the model answers confidently from it.
2. The common failures are **bad text, bad chunking, missed retrieval, stale or leaky indexes, wrong context size and no "not found"**.
3. Diagnose by **logging and reading retrieved chunks** and measuring **recall at k** on a test set, separately from answer quality.
4. Fix retrieval with clean text, structure-aware chunks, **hybrid search**, **reranking** and **metadata filters**.
5. Keep the index **fresh** and **permission-aware**, and let the system say "I could not find that".
