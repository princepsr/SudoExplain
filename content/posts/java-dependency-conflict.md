---
title: NoSuchMethodError in production: Java dependency conflicts
date: 2026-11-01
description: NoSuchMethodError in production usually means two versions of a library are on the classpath. Learn to find the wrong jar and fix the conflict.
tags: java, maven
draft: true
---

## The question

The feature works on your laptop. The tests pass. The build is green. You deploy, and the first request that touches the feature fails with this:

```text
Exception in thread "main" java.lang.NoSuchMethodError: 'java.lang.String acme.Fmt.loud(java.lang.String)'
	at Main.main(Main.java:1)
```

The method `loud` exists. You can see it in the source of the library. You compiled against it an hour ago.

> The code compiled, so how can the method be missing at runtime?

Because the jar that was **compiled against** and the jar that **runs** are not the same version. This post shows how that happens and how to find the jar that actually loaded.

> [!SUMMARY]
> By the end you will know:
>
> 1. What the classpath is, and how a library can arrive twice in two versions
> 2. How Maven and Gradle pick a version, and why they can disagree
> 3. How to **diagnose** the conflict with dependency trees and class-loading logs
> 4. How to fix it with version management, exclusions and, last, shading

## First, the classpath and transitive dependencies

The **classpath** is the list of jars (zipped bundles of compiled Java classes) the JVM searches when your code uses a class. The JVM (Java Virtual Machine, the program that runs your code) takes the **first** match it finds and ignores any later copy of the same class.

You rarely list every jar yourself. You declare a few **direct dependencies**, and each one brings its own dependencies, called **transitive dependencies**. A build tool such as Maven or Gradle works out the full set. When two libraries need different versions of the same third library, the tool must choose one. The other version is dropped.

Think of two recipes that both call for "the sauce". One means the 2019 recipe and the other means the 2024 recipe. The kitchen keeps one jar of sauce. One recipe now gets a sauce it was never written for.

## The failure: the library you compiled against is not the one that ships

Take two invented libraries. `acme-report` needs `acme-text` 1.0. `acme-export` needs `acme-text` 2.0, which renamed `shout` to `loud`:

```diagram
type: flow
alt: Two libraries need different versions of acme-text, only version 1.0 is packaged, and a call to a method that exists only in 2.0 fails at runtime.
caption: Figure 1. The build succeeds because each library compiled in its own world. The crash waits for runtime.
Report lib needs acme-text 1.0 -> Export lib calls the 2.0 API -> Only 1.0 is packaged in the jar -> NoSuchMethodError in production !
```

Nothing fails at build time. Each library was compiled against its own version, and the build tool only checks that jars can be found. The mismatch appears at the first call to the missing method.

I reproduced this with two tiny jars. I compiled a `Main` class against `acme-text-2.0.jar`, then ran it with `acme-text-1.0.jar` on the classpath. The error at the top of this post is the real output.

Depending on what changed between versions, you may see different errors:

| Error | What it usually means |
|---|---|
| `NoSuchMethodError` | A method was removed or renamed, or its parameters changed |
| `NoSuchFieldError` | A field was removed or renamed |
| `NoClassDefFoundError` (or `ClassNotFoundException` when a class is loaded by name) | A class was moved or removed |
| `AbstractMethodError` | An interface gained a method the loaded class lacks |

## How Maven and Gradle choose

**Maven** uses **nearest definition** wins. Its documentation says it picks the version of the dependency closest to your project in the tree. If two are at the same depth, the first one declared wins. Newer does not matter.

**Gradle** works differently. Its documentation says it considers every requested version and, by default, selects the **highest**.

So the same project can resolve `acme-text` to 1.0 in Maven and to 2.0 in Gradle. This is one reason a conflict appears in one environment and not another.

The IDE, tests and the packaged artifact can also differ. Tests add test-scope jars. A "fat jar" or a web server may bring its own copies of libraries. Your IDE may resolve the tree with a different tool than the one that builds the release.

## How to diagnose it

**1. Read the error.** The class and method named in the error tell you which library to look at. Here it is `acme.Fmt`.

**2. Print the dependency tree.** For Maven:

```bash
mvn dependency:tree -Dverbose -Dincludes=com.acme:acme-text
```

`-Dverbose` includes entries the resolver dropped, and `-Dincludes` filters the tree to matching artifacts, written as `groupId:artifactId`. This is illustrative output, not from a real run:

```text
com.example:my-app:jar:1.0
+- com.acme:acme-report:jar:3.1:compile
|  \- com.acme:acme-text:jar:1.0:compile
\- com.acme:acme-export:jar:2.0:compile
   \- (com.acme:acme-text:jar:2.0:compile - omitted for conflict with 1.0)
```

The parenthesized line is the loser. Both copies sit at the same depth, so Maven's tie-break applies: the dependency declared first, `acme-report`, wins. That is why Maven kept 1.0, and `acme-export` runs against a version older than the one it needs.

For Gradle, ask why a version was chosen:

```bash
./gradlew dependencyInsight --dependency acme-text --configuration runtimeClasspath
```

**3. Ask the JVM which jar a class came from.** This is the proof. Start the application with class-load logging:

```bash
java -Xlog:class+load -jar app.jar | grep acme
```

On JDK 9 and later, the older flag `-verbose:class` gives the same lines. In my test run the log contained a line shaped like this (path shortened):

```text
[0.244s][info][class,load] acme.Fmt source: file:/.../acme-text-1.0.jar
```

The text after `source:` is the jar that supplied the class. If it is not the version you expected, you have found the conflict.

**4. Check the packaged artifact, not just the IDE.** Run the same checks against the build output you deploy. Unzip the jar and list the `lib` folder, or run the tree command on the production build.

## Fix 1: manage the version in one place

In Maven, declare the version you want in `dependencyManagement`. It overrides the version picked for transitive dependencies:

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.acme</groupId>
      <artifactId>acme-text</artifactId>
      <version>2.0</version>
    </dependency>
  </dependencies>
</dependencyManagement>
```

Maven's documentation says dependency management takes precedence over mediation for transitive dependencies. If a vendor publishes a **BOM** (bill of materials, a POM that lists matching versions of many artifacts), import it with `<scope>import</scope>` and let it set the versions together.

The cost: you now own the choice. If `acme-report` truly breaks on 2.0, you have moved the failure to a different library. Test after every pin.

## Fix 2: declare it explicitly, or exclude the loser

Declaring `acme-text` 2.0 as a direct dependency of your project also wins, because direct is nearest. Or you can **exclude** the unwanted copy from the library that brings it:

```xml
<dependency>
  <groupId>com.acme</groupId>
  <artifactId>acme-report</artifactId>
  <version>3.1</version>
  <exclusions>
    <exclusion>
      <groupId>com.acme</groupId>
      <artifactId>acme-text</artifactId>
    </exclusion>
  </exclusions>
</dependency>
```

The cost: an exclusion removes that library everywhere under `acme-report`. If nothing else supplies it, you swap one error for another.

## Fix 3: fail the build on conflicts

The Maven Enforcer plugin has a `dependencyConvergence` rule. Its documentation says it requires every dependency to resolve to one version throughout the tree. When two differ, it fails the build and lists the paths to each version:

```xml
<configuration>
  <rules>
    <dependencyConvergence/>
  </rules>
</configuration>
```

You put this inside the plugin's `enforce` goal. It turns a production surprise into a build failure. The cost is noise: real projects often have many conflicts, and you must resolve or accept each one.

## Fix 4, last resort: shade and relocate

If two libraries truly need incompatible versions, you can **shade** one: copy it into your jar and **relocate** its package to a new name, so the two copies no longer clash. Maven's shade plugin does this. It is a heavy tool. It increases jar size and can hide security fixes, so use it only when no single version works.

## When the fix goes wrong

Each fix changes which jars ship, so each fix can break a library that worked before. Three cases need care.

**1. Pinning a version that breaks another library.** The error names `acme-export`, so you pin `acme-text` to 2.0, and `acme-export` works. It looks solved. But `acme-report` was written for 1.0, and 2.0 renamed `shout` to `loud`. Nothing was lost by the build tool. It simply gave `acme-report` a version it was never compiled against. The same kind of error appears, now on a different library (illustrative):

```text
java.lang.NoSuchMethodError: 'java.lang.String acme.Fmt.shout(java.lang.String)'
```

This can be worse than the first failure. If only a rare report screen calls `shout`, your tests may never touch it, and you find out in production.

**What to do instead.** Before you pin, read what changed between the two versions, and check whether each library that needs the dependency supports the version you pick. If `acme-report` has a newer release built for 2.0, upgrade it too. After the pin, run tests that actually exercise each library, not just the one you were fixing. If no single version works for both, that is the case for shading (Fix 4).

**2. Excluding too much.** An exclusion removes a jar from one path in the tree, together with everything below it on that path. Suppose you exclude `acme-text` from `acme-report`, hoping the 2.0 copy from `acme-export` will be used. That works while `acme-export` really brings 2.0. Later someone removes `acme-export`, or upgrades it to a release that no longer depends on `acme-text`. Now nothing supplies the library, and `acme-report` fails with `NoClassDefFoundError` the first time it needs it. An exclusion on a whole group (`<artifactId>*</artifactId>`) can remove many jars at once.

**What to do instead.** Exclude one named artifact, never a wildcard. Then make the winner explicit: declare `acme-text` 2.0 in your own project, so it no longer depends on a side effect of another library. Finally, run the dependency tree again and confirm the jar you want is there.

**3. Checking the wrong classpath.** You fix the conflict, the IDE shows the right version, and the tests pass. But the IDE and the test run may resolve jars differently from the release build. Tests add test-scope jars, so a jar that exists only in tests can hide the problem. A fat jar or a web server may also bring its own copies of libraries. The artifact you deploy can still contain the old jar.

**What to do instead.** Check the thing you ship. Run the dependency tree for the production build, unzip the artifact and look at the jars inside, and start it with `-Xlog:class+load` to see which jar each class comes from.

The smaller ones:

- **Silencing the enforcer.** Turning the rule off removes the early warning.
- **Trusting "latest".** The newest version is not always compatible with everything else.

## Which should you use?

| Situation | Reach for |
|---|---|
| Many libraries from one vendor | **Import their BOM** |
| One library with the wrong version | **`dependencyManagement` pin** |
| One path brings an unwanted copy | **An exclusion** |
| You want to stop this happening again | **Enforcer `dependencyConvergence`** |
| Two incompatible versions are both needed | **Shade and relocate** |

If you are not sure, find the jar first. Run the class-load log, read the `source:` line, and compare it with the dependency tree.

## See it yourself

Compile a one-method class into `acme-text-1.0.jar`. Compile a second version with the method renamed into `acme-text-2.0.jar`. Compile a caller against version 2.0, then run it with version 1.0 on the classpath and read the error.

> [!WARNING]
> Do this in a scratch folder outside any real project, so no test jar leaks into a build you deploy.

## The takeaway

1. The **classpath** is a list of jars, and the JVM uses the **first** copy of a class it finds.
2. Two libraries wanting different versions of a third forces the build tool to **drop one**.
3. Maven keeps the **nearest** version. Gradle keeps the **highest**, so they can disagree.
4. Diagnose with the **dependency tree** and `-Xlog:class+load`, which names the jar a class came from.
5. Fix with **version management**, then exclusions, then enforce convergence. Shade only as a last resort.
