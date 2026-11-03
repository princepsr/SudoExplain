---
title: Split brain: when two servers both think they lead
date: 2026-11-01
description: What split brain is, how a network partition makes two servers both act as primary, and how quorum, fencing, and a witness node prevent it.
tags: distributed-systems, databases
draft: true
---

## The question

A company runs a database primary in one data center and a standby in another. During a night of network trouble, the link between the two sites drops for ninety seconds. The standby decides the primary is dead and promotes itself. But the old primary was never dead. It was only cut off.

When the network comes back, both servers have accepted writes. Both have an order 5001, with different contents. Nobody can merge them cleanly.

> How can two servers both believe they are the only leader, and why can't they just compare notes?

They cannot compare notes during the partition, and each one acted on a guess.

> [!SUMMARY]
> By the end you will know:
>
> 1. What leaders and followers are, and how a server decides another one is "dead"
> 2. Why a **network partition** can make two leaders, called **split brain**
> 3. How to **spot** it from the evidence it leaves
> 4. How **quorum**, **fencing**, and a **witness node** prevent it, and how to recover when it happens

## First, leaders and followers

Many systems pick one server as the **leader** (also called primary or master). The leader decides the order of writes, and **followers** (standbys, replicas) copy it. One leader keeps the data consistent, because there is only one history to agree on.

If the leader fails, a follower must take over, which is called **failover** or **promotion**. The hard part is knowing the leader has really failed. Followers usually watch for a **heartbeat**, a small "I am alive" message sent every second or so. When no heartbeat arrives within a time limit, the leader is declared dead.

Think of a ship's captain. If the radio goes silent, the deputy takes command. But if the captain is merely out of radio range, now two people give orders. The silence did not prove the captain was gone.

## The failure: silence is not death

Timeouts cannot tell a **dead** server from a **slow** one, or from one the network cannot reach. All three look the same: no reply. A partition (a network failure that splits servers into groups that cannot talk to each other) makes this worse, because **both sides** see silence from the other.

```diagram
type: sequence
alt: A partition cuts the link, the standby promotes itself, and both servers accept different writes from different clients.
caption: Figure 1. Neither server is broken, yet both lead and both accept writes.
actors: Old primary | Standby | Client A | Client B
Standby -x Old primary: heartbeat lost (partition)
note Standby: no reply, assumes it died
note Standby: promotes itself to primary !
Client A -> Old primary: write order 5001 = book
Client B -> Standby: write order 5001 = lamp !
note all: two leaders, two histories !
```

Each client sees a healthy server. Each write is acknowledged. Nothing looks wrong until the network heals, and the two histories turn out to conflict. This is **split brain**: two parts of one system, each acting as the single leader.

```diagram
type: flow
alt: A partition causes missed heartbeats, the standby promotes itself, and then both servers accept writes.
caption: Figure 2. Each step is reasonable on its own. Together they lose data.
Link between sites fails -> Heartbeats stop arriving -> Standby promotes itself -> Both accept writes !
```

## Why two nodes can never be enough

With exactly two servers, a partition leaves one against one. Each side asks, "have I lost the other, or has the other lost me?" and cannot tell. If the rule is "promote when the other is silent," both promote. If the rule is "never promote on silence," a real crash leaves nobody in charge. Two nodes force a bad choice.

## How to diagnose it

- **Ask each node what it believes.** In PostgreSQL, `SELECT pg_is_in_recovery();` returns false on a primary and true on a standby that is replaying the log. If two nodes answer false, you have two primaries. Most databases and cluster managers have an equivalent status command.
- **Look for the partition in the logs.** Search for missed heartbeats, "lost connection to peer", election messages, or failover events. Match their timestamps across all servers.
- **Check what clients saw.** Connection logs and load balancer logs show which clients talked to which node during the window.
- **Look for divergence.** Compare row counts and the highest ids on each side. The same key with different contents is conflicting data, and ids that exist on one side only are writes the other missed.
- **Check for write conflicts in replication logs.** After the link returns, replication errors or refusals to attach the old primary to the new one are a typical sign.

> [!WARNING]
> If you suspect split brain, stop writes to one side first. Do not reconnect the two servers and let them sync, because that can overwrite the history you may need.

## Fix 1: require a majority (quorum)

A **quorum** is the minimum number of nodes that must agree before an action counts. The common rule is a **majority**: more than half of all members. For `n` nodes, the majority is `n/2 + 1`, rounded down. etcd's documentation gives it as `(n/2)+1`.

Say 5 nodes get split 3 and 2. The group of 3 has a majority, so it may elect a leader and accept writes. The group of 2 does not, so it cannot elect anyone and stops accepting writes. Two majorities cannot exist at once, because any two groups of more than half must overlap in at least one node.

This also explains the **odd number** rule. With 4 nodes, the majority is 3, so the cluster still tolerates only 1 failure, the same as with 3 nodes. A 4-4 split of 8 nodes gives nobody a majority. The etcd FAQ says adding a member to reach an even count does not buy additional fault tolerance, and the ZooKeeper administrator's guide recommends an odd number of servers. A 3-node cluster survives 1 failure, and a 5-node cluster survives 2.

The cost is availability. The minority side stops, by design. It is better to be unavailable for ninety seconds than to be wrong.

## Fix 2: how consensus systems avoid it, in principle

Systems such as etcd and ZooKeeper use **consensus** protocols, which are algorithms for a group of servers to agree on one order of events. In etcd, members elect a single leader, and an update needs a majority. A leader cut off from the majority cannot finish writes, because it cannot collect enough acknowledgements.

A cut-off old leader may still believe it leads for a while. In Raft, the protocol etcd uses, leaders carry a **term** number, and members reject anything from an older term. A cut-off leader cannot commit anything, because it cannot reach a majority. If it reconnects, the members reject its older term and it steps down. This is a high-level picture, and details differ between systems.

## Fix 3: fencing, shutting the old leader out

Quorum decides who should lead. **Fencing** makes sure the old leader truly cannot act. There are two kinds:

- **Shut it down.** The idea behind **STONITH** ("shoot the other node in the head") is that the new leader first powers off or isolates the old one. It can use a power switch, or cut the old leader's storage access. Only then does it take over.
- **Reject stale leaders at the resource.** Give each leader a number that grows with each election, and have the storage refuse writes from an older number. These are **fencing tokens**, explained in [the distributed lock failures post](/posts/distributed-lock-failures/).

The cost is more machinery, and the fencing mechanism itself must be reliable. A fence that fails open gives you no protection at all.

## Fix 4: add a witness

If you cannot afford a third full server, add a small **witness** (or arbiter): a node that holds no data and only votes. With a primary, a standby, and a witness, a partition that isolates one data node leaves the other still able to reach the witness. That makes two out of three, a majority. Put the witness in a third location, or an outage of one site takes out two votes at once.

## Fix 5: do not promote automatically without safeguards

Automatic failover is convenient, but it is the very step that causes this failure. Safer choices:

- Require a quorum or a witness to agree before promoting.
- Make the old leader stop itself when it loses contact with the majority.
- Use longer timeouts, so a short network blip does not trigger a failover. The cost is a slower reaction to real failures.
- For two-node systems, consider a manual promotion step.

## Recovery: choose a winner

If split brain has already happened:

1. **Stop writes** on at least one side.
2. **Choose the winner,** usually the side that accepted the most important or the most writes.
3. **Extract the loser's writes** made during the partition, by exporting them or reading the logs.
4. **Reconcile consciously.** Replay them on the winner if they do not conflict, or review each conflict by hand. Discarding writes is a business decision, because someone's order or payment may vanish. Tell the owners.
5. **Rebuild the loser** as a fresh follower of the winner.
6. **Fix the cause** before you re-enable automatic failover.

## When the fix goes wrong

These fixes look complete on a diagram. Three of them fail in ways that only show up during a real outage.

**1. A witness in the same site.** You have a primary in site A, a standby in site B, and a witness in site A, because that is where the spare machine was. That is 3 votes, so it seems safe.

Now site A loses power. The primary and the witness both go down, and only 1 of the 3 votes is left. One vote is not a majority, so the standby in site B correctly refuses to promote itself. Nobody is in charge, and you are down until a person steps in. The witness did not break anything. It just was not independent of the primary.

**What to do instead.** Put the witness in a third location that fails separately, such as another data center or cloud region. Then losing any one site leaves 2 of 3 votes.

**2. A fence that depends on the network.** Fencing means making sure the old leader truly cannot act. A simple design is: the new leader sends the old one a "shut down" message. But in a partition, the old leader is exactly the server you cannot reach over that network. The message never arrives, and the old leader keeps accepting writes. The fence fails at the moment you need it.

There is a second mistake. If the fence call fails and the new leader promotes anyway, you have two leaders again.

**What to do instead.** Use a path that does not share the failure. Examples are a power controller on a separate management network, or storage that refuses writes from the old leader (see fencing tokens above). And make the rule strict: if the fence is not confirmed, the standby does **not** promote. It is better to be down than to have two leaders.

**3. Timeouts that are too tight.** A short heartbeat timeout reacts fast, but it cannot tell a dead server from a stalled one. Say the timeout is 10 seconds. The leader freezes for 20 seconds, for example in a long garbage collection pause (when a program stops to clean up memory). The followers hear nothing for 10 seconds, elect a new leader and move on.

Then the old leader wakes up. It does not know that time has passed. It still believes it leads, and it may accept a write before it hears about the new election. It does not matter that it checked a moment ago, because the pause can happen right after the check.

**What to do instead.** A longer timeout reduces false alarms, at the cost of a slower reaction to real crashes. It cannot remove the risk, so also make the **storage** reject the old leader: with fencing tokens, the write from the stale leader carries an old number and is refused.

Smaller pitfalls:

- **Even-sized clusters.** A 2-2 split has no majority on either side, so everything stops.
- **Fixing the database but not the clients.** Clients holding old connections can keep writing to the old leader. Re-resolve addresses and drop old connections on failover.

## Which should you use?

| Situation | Reach for |
|---|---|
| Building a replicated cluster | **Quorum** with an odd number of nodes |
| Only two data sites | **A witness** in a third place |
| Old leader may still be alive | **Fencing**: STONITH or tokens |
| Automatic failover | **Safeguards** before any promotion |
| Split brain already happened | **Stop one side**, then reconcile on purpose |

If you are not sure, choose consistency over availability for data that must not diverge, and let the minority side stop.

## The takeaway

1. A **timeout cannot tell dead from unreachable**, so a partition can make both sides promote a leader.
2. **Split brain** means two leaders accept writes and the histories diverge.
3. **Quorum** (a majority) lets only one side lead, which is why clusters use an **odd** number of nodes.
4. **Fencing** and a **witness** stop the old leader from acting, so do not auto-promote without safeguards.
5. If it happens, **stop one side, pick a winner**, and reconcile or discard writes as a conscious decision.
