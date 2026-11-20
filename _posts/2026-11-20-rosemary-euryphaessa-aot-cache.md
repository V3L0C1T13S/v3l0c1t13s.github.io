---
title: "building an aot cache for rosemary, and microlift's origins in bin2bin hardening"
date: 2026-11-20
tags: [software engineering, rosemary, microlift, recompilation, obfuscation, bin2bin, jit, caching]
art: larkspur
---

Cold start is expensive for a recompiler. The first time you launch something the size of Roblox through Rosemary, the emulator has to lift and compile a large amount of x86-64 before a single frame appears. That used to take around two minutes, in that amount of time you could get up and make yourself a coffee while Rosemary was busy lowering all the CLIF instructions, or, if you're British, start the kettle.

So we built an on-disk cache: compile the program ahead of time, write it to disk, and map it back in on the next launch. The cache can run compiled guest code directly from the file. That sounds risky, so the important question is what makes the code safe to reuse.

The answer starts with a related project that predates Rosemary and gave its instruction lifter a very different job.

## The cache and the lifter

When [the AOT work landed](https://github.com/microlift/rosemary/pull/268), the central design decision was not to build a second compiler with subtly different semantics. The cache stores the JIT's own output after making it relocatable. The design was pretty simple, but effective and provable.

> Relocatable references become the one code form both the JIT and the AOT compiler emit, so cached code is the same code the test suite and the Unicorn differential tester check.

The offline builder uses the same lift as the JIT, over the same regions, and the result is covered by the same differential tester checks. A later run can map that code and execute it without introducing a second translation path that might drift from the JIT.

This depends on the live JIT output being trustworthy down to the last bit. Microlift was built to meet that bar well before Rosemary's cache existed.

## A lifter built for exactness

Rosemary recompiles x86-64 using Microlift, our machine-code lifter: it reads guest instructions and expresses what they do in [Cranelift](https://cranelift.dev/) IR, which Cranelift then compiles down to whatever the host CPU happens to be. Longtime readers have met it before - it's the thing turning Intel code into Apple-silicon code in the [first Rosemary post]({% post_url 2026-09-10-rosemary %}).

Microlift began as a subproject of Euryphaessa, a sibling project that isn't public. Euryphaessa is a binary hardener. Rather than monitor a process from a kernel driver, it makes the *code itself* difficult to understand. It can take functions from an existing binary, lift them to IR, transform that IR, then lower it back to native code with the same behavior.

Preserving behavior is the constraint. If a hardened function differs by even one bit, the program may break. Microlift was therefore designed for 1:1 accuracy with a real CPU, and that requirement shows up in several places:

- All side effects are preserved, even rare ones. Microlift models condition flags like carry, overflow, zero, sign, and friends as real arithmetic on SSA values. The unused ones are removed when Cranelift optimizes the code, but every handler still has to compute them exactly the way the silicon would. There's no "close enough" for things like the [Auxiliary Carry Flag](https://www.geeksforgeeks.org/computer-organization-architecture/auxiliary-carry-flag-in-8086-microprocessor/) on most architectures.
- x87 is 80-bit softfloat, in pure IR. You cannot borrow the host's 64-bit floats and stay faithful to an 80-bit FPU, so we don't. It's all synthesized, and checked against a reference float library.
- We don't trust ourselves. The test suite runs lifted code against [Unicorn](https://www.unicorn-engine.org/), a real CPU emulator, instruction by instruction, and screams if they ever disagree. There's a case where Microlift is actually *more* correct than Unicorn on a nasty NaN-propagation edge case, which is the kind of thing you only find when you check everything.

That history matters to the cache. Rosemary can reuse compiled code because Microlift was already designed to preserve the guest CPU's behavior exactly.

## Turning arithmetic inside out

Euryphaessa's transformations show why that accuracy matters. The lifter has to preserve the meaning of the code even when the resulting instructions are hard to recognize.

The main pass uses Mixed Boolean-Arithmetic (MBA) obfuscation. The idea predates Euryphaessa; a modern treatment appears in the [Loki paper](https://www.usenix.org/conference/usenixsecurity22/presentation/schloegel). The basic observation is that the same integer result can come from expressions that look quite different. For example, `x + y` is equal to `(x ^ y) + 2·(x & y)`. A pass can replace an addition with that form, then transform parts of the expression again.

For demonstration purposes, we can use this tiny implementation of it. Lift a single `add rax, rsi`, find the `iadd` it produced, and relocate it:

```rust
// result = iadd(x, y)  ->  result = (x ^ y) + 2*(x & y)
let (x, y) = (args[0], args[1]);
pos.goto_inst(inst);

let xor     = pos.ins().bxor(x, y);          // x ^ y
let and     = pos.ins().band(x, y);          // x & y
let two_and = pos.ins().ishl_imm_u(and, 1);  // 2 * (x & y)

// relocate the existing add at the new operands. same result value, same uses
let new_args = pos.func.dfg.inst_args_mut(inst);
new_args[0] = xor;
new_args[1] = two_and;
```

Microlift lifts `add rax, rsi` to a single Cranelift `iadd` (`v60` is `rax`, `v59` is `rsi`), and the pass turns it into the four-instruction MBA form:

```
; before: 1:1 mapping of `add rax, rsi`
    v61 = iadd.i64 v60, v59

; after: x + y  ->  (x ^ y) + 2*(x & y)
    v272 = bxor.i64 v60, v59
    v273 = band.i64 v60, v59
    v275 = ishl.i64 v273, v274  ; v274 = 1
    v61 = iadd.i64 v272, v275
```

`v61` still names the sum, so everything downstream keeps working without noticing.

The production pass combines these identities and wraps intermediate values in a non-linear permutation: multiply by an odd constant, apply an xor-shift, then undo both operations. The net result is unchanged, but the intermediate form is harder to simplify with linear algebra. The same differential tester used for the rest of Microlift checks that the transformed code still behaves correctly.

This was used in production in [Sober](https://github.com/vinegarhq/sober), which runs the Android Roblox client on Linux. For a time, Euryphaessa's hardening protected parts of Sober's code. I'll explain later why I'm writing about that work now.

## SSE emulation horrors

The same transformations can make ordinary vector arithmetic look quite different after lifting.

Microlift can lower SSE vector math in two ways. It can emit native SSE instructions such as `paddq`, or expand each packed operation into scalar `iadd`, `isub`, `band`, `bor`, and `bxor` operations on the two 64-bit lanes. The scalar form is slower, but it works on more targets and the differential tester checks that it matches the native instruction bit for bit.

The MBA pass works on those scalar integer operations. A native `paddq` is opaque to it, but with native SSE emission disabled, a vector add becomes scalar IR that the pass can transform.

As an example, here's a routine for a game scrambling a player's guess before comparing it:

```asm
paddq xmm0, xmm1   ; mix in a salt
pxor  xmm0, xmm2   ; fold
psubq xmm1, xmm3   ; unmix, differently
pand  xmm0, xmm1   ; mask
ret
```

Now, using Microlift with scalar expansion on and source locations enabled, each packed op becomes two i64 lane-halves of plain integer math:

```
    ; guest 0x1000
    v63 = iadd.i64 v59, v61      ; paddq, low lane
    ; guest 0x1000
    v64 = iadd.i64 v60, v62      ; paddq, high lane
    ; guest 0x1004
    v67 = bxor.i64 v63, v65      ; pxor,  low lane
    ; guest 0x1004
    v68 = bxor.i64 v64, v66      ; pxor,  high lane
    ; guest 0x1008
    v71 = isub.i64 v61, v69      ; psubq, low lane
```

Microlift can preserve each instruction's guest address in the IR. That makes a fresh lift easier to read and lets Rosemary map a crash in compiled code back to the guest instruction. The transformations below also show how much that annotated IR can change.

For a stress test, we ran the MBA pass repeatedly, with Cranelift's optimization passes between rounds. An optimizer can simplify obfuscated expressions, so this shows both how much it recovers and how much structure remains:

```
baseline MBA sites: 14
round 1: rewrote  14 sites ->  243 insts, optimize ->  367 insts, 103 sites remain
round 2: rewrote 103 sites -> 1439 insts, optimize -> 1056 insts, 321 sites remain
round 3: rewrote 321 sites -> 5284 insts, optimize -> 3506 insts, 1249 sites remain
```

The optimizer reduces the instruction count in rounds two and three, from 1,439 to 1,056 and from 5,284 to 3,506. But the non-linear permutation remains, and after three rounds the original fourteen scalar operations have become 1,249 instructions. More rounds would increase the output further.

Optimization also changes the IR's structure. When the next round runs, it finds new expressions to transform, so the number of sites grows from 14 to 103, then 321, then 1,249. In this case, optimization gives the following obfuscation pass more material to work with.

After three rounds, the IR is difficult to connect to the original vector operations:

```
    v7533 = bxor.i64 v809, v807
    v7537 = bxor.i64 v812, v7533
    v7541 = bxor.i64 v815, v7537
    v3003 = bxor.i64 v3000, v3002
    ...  (1249 MBA instructions total)
```

The result is difficult to read, but it still computes the same operation. You can also technically go further with this and expand standard 64-bit integer math into 128-bit SSE math pre-obfuscation, but that's for another day.

## Why keep the code native?

One alternative is a virtualizing obfuscator: translate a function into a custom bytecode and ship an interpreter for it.

Euryphaessa takes a different approach. A VM can make code difficult to follow, but its handler table and dispatch loop are shared across every protected function. Once those are understood, the same analysis can be reused. The protection concentrates much of its structure in one place.

Euryphaessa lifts, transforms, and lowers the function back to native code. That has two practical advantages:

- There is no shared interpreter or bytecode format to recover. Each function is native code, transformed independently. That makes analysis a per-function task, with the MBA and permutation passes adding complexity to each one.
- The code runs natively, so the overhead comes from the extra arithmetic rather than interpreter dispatch. This approach handled demanding workloads: Euryphaessa recompiled a RISC-V interpreter running Linux without a dramatic slowdown, and ran hardened code inside an SDL audio callback on a 96 kHz device, where missed deadlines would have caused audible glitches.

Rosemary makes a related choice for a different reason. Euryphaessa uses native code because performance and per-function obfuscation matters; Rosemary uses it to translate x86-64 efficiently. Both depend on Microlift preserving guest behavior. If you've ever had to run an actual OS under an x86 interpeter, such as [Bochs](https://github.com/bochs-emu/Bochs) (an amazing project, by the way!), then tried the same OS with [QEMU](https://www.qemu.org/), the difference is night and day - an interpreter is just too slow for realtime programs.

## Wait, why exactly are you telling us this?

Obfuscation write-ups rarely describe the product they were used in. In this case, the circumstances have changed.

When Euryphaessa's hardening was used in Sober, it addressed a problem the project had at the time. Roblox asked us to keep Sober closed source - it still is, and we respect that gentleman's agreement. As a stop-gap measure to further give Roblox reason to keep us around, we added sophisticated anti-tamper and obfuscation measures to some bits of Sober that protected `libroblox.so` from being meddled with, which we think were pretty effective back in their prime. Most of these measures still exist, though they are weakened to just user convenience features (such as reinstalling the APK if corruption is detected). Some of you who have reverse engineered Sober before are very likely familiar with Euryphaessa's core library, `libloader.so`, a runtime for Sober's protected binary akin to Roblox's `RobloxPlayerBeta.dll`. Yes, we had a runtime for a runtime, that is effectively what any good anti-tamper is: a custom runtime.

Since then, open-source alternatives have changed that landscape, and the case for adding anti-tamper protection has weakened. That protection has a cost for users, and for us. I spent almost a month on one very specific semantic accuracy bug that I want to write about very soon, but to be honest, I'm also not entirely sure what fixed it! The fix was in a full on rewrite of recompiled code entry rather than just a one-off thing.

Tangent aside, when the cost no longer makes sense for the project, it is better to remove it. That also means I can describe the engineering in the open. The hardening served its purpose, and today, the emulator that was developed from the same work is the more active project.

## Making compiled code reusable

The cache took form over six phases, tracked in [rosemary#93](https://github.com/microlift/rosemary/issues/93). The first working version exposed enough problems that much of its design had to change.

The first step was making the code movable. When we started, Rosemary's JIT output was full of things that only made sense inside one process. Calls into host libraries were baked in as raw addresses, guest addresses were baked in as raw addresses, and every region got its own Cranelift module with fixed symbol names. Host ASLR shuffles all of that on every launch, so a file full of that code would be valid for exactly one run.

Microlift had a tempting shortcut lying around: `RuntimeAssisted`, an execution mode left over from Euryphaessa, which already called host functions through relocations instead of addresses. We audited it and decided not to use it. The Unicorn differential tester never runs against it, it refused the block linking Rosemary depends on, and it identified an import by *name alone*. On macOS that's actually wrong: two images can both import `_foo` from two different libraries, and that mode would quietly send both to whichever one it saw first. Cached code that skipped the differential tester was exactly the "subtly different offline compiler" that you want to avoid at all costs.

So we went the other way and made every lift relocatable, JIT included. Host references became symbols keyed by provider, name and ABI. Guest addresses became `slide + va`. The JIT just resolves those on the spot when it defines a function.

Next, we borrowed from [FEX](https://github.com/FEX-Emu/FEX). They had already worked out the operational side, so we took its newer CodeCache model basically entirely, however, there's no persistent JIT cache. Instead, every time a run misses on image code, it appends an 8-byte address to a per-image profile log. An offline recompiler, `rosemary aot`, then rebuilds one immutable file per image from that log: write a temp file, `fsync`, `rename`. Readers just map whatever's there, and the only lock is to stop two builders from doing the same work twice. Files are keyed by a build id (the exact Rosemary, Microlift and Cranelift-fork revisions), the machine, a fingerprint of every codegen knob, and the image's hash, so a stale cache simply never matches.

`rosemary aot` loads the program without running any of it and works through entry points in priority order: Objective-C `+load` and other `IMP`s, initializers, exception landing pads, the entry point, the profile log, and finally everything else in `LC_FUNCTION_STARTS`. It picks each region with the JIT's own region selector, so offline regions are the same regions the JIT would have picked. It also writes in priority order, so a build that gets cut off is still useful. (A few regions of unrolled crypto lift to over 130,000 Cranelift instructions and eat 1-2 GiB each while compiling, so those draw on a shared memory budget). Objective-C start-up got its own phase too: thunks are now built once per signature instead of once per method, and `IMP` lifts moved off the main thread.

The first measurements were disappointing. On Roblox, the JIT alone used 9.5 GB. Every region was its own module with its own pages for code, data and link cells, which is at least 32 KiB per region on a 16 KiB-page host, for regions that were often a few hundred bytes. Roblox compiles 280,000 of them. The cache was worse. Cached code carried little 16-byte literal pools that had to be patched at load, so the whole file got copied into memory and relocated before anything ran. A full Roblox build didn't finish in two minutes, the file came out at 5.5 GB, and every one of its 770,000 regions was decoded and published up front.

The next major change was to make the cache position-independent, following an approach used by Rosetta 2. Rosetta 2's `oahd` doesn't patch anything at load. It translates into a signed file that the kernel maps executable as-is. It turns out Darwin will do that for any file, not just a Mach-O: `fcntl(F_ADDSIGS)` attaches an ad-hoc code signature, and after that its pages can be mapped executable. But that only works if the code has nothing left to patch. So Phase 6 made everything position-independent. Every host reference, the guest slide, and each region's link cells are loaded from a GOT entry. On AArch64 that's an `adrp; ldr` pair, 8 bytes with no branch, where the old literal pool was 16 bytes plus a taken branch. The GOT lives beside the code instead of inside it, so the code pages are identical in every process. The JIT compiles that exact same way too.

The rest came out of that:

- JIT regions get packed densely into a shared arena instead of each taking a page or more. That alone took `tools/unitybench` from 4.1 to 1.55 ms a frame.
- A cache file is just code back to back from a page boundary, plus fixed-size metadata records found through a sorted index. Nothing is decoded until a run first reaches a region, and publishing goes through the same in-flight claim a JIT lift takes, so two threads missing on the same address wait for one another instead of doing the work twice.
- Darwin validates the signature the first time a file's pages go executable, at roughly a second per 200 MiB. So the builder maps each file once right after writing it, which means it pays that cost and the game doesn't. That's also why the cache is split into parts: part 0 is small enough to build in about 28 seconds and validate quickly, and the cold parts can take their time.

On top of that, two bugs were discovered from the performance improvement! Roblox's crash reporter forks at start-up, and with threads now spending far more time inside the code cache's locks, the child kept inheriting a held lock and dying in libdispatch. Now the forking thread takes every code-cache lock before the fork. Roblox also `dlopen`s its own executable, which used to load a whole second copy with its own statics, so half of what ran was running outside the cache. Now that call gets back the copy that's already loaded, which is what dyld does.

A few things are still open. Cold parts are compiled at the cheap tier, which is about 2.5x bigger, so Roblox's cache is 6.3 GB on disk, 0.8 GB of it part 0, Darwin forgets its validation across a reboot, so the first run after one most likely pays it again for part 0, and regions that folded in a pointer read from outside its own bytes is only usable at the slide it was lifted at. Since macOS slides the main executable on every launch, those regions get refused at load and the JIT covers them.

## Changes to the cache

The AOT work in [PR #268](https://github.com/microlift/rosemary/pull/268) combines three changes.

Tiered compilation gives every region a quick first version. The new `fast` tier uses Cranelift at `opt_level=none` with the single-pass register allocator. It compiles about twice as fast, though the resulting code runs at roughly half speed. Worker threads then recompile hot regions at full optimization and replace the first version. A thread already running the old code can finish there; its inter-block links are carried over during the swap.

With lift-ahead, translating a region also queues its constant branch and call targets for worker threads to compile. It looks a few steps down the control-flow graph, and queues start-up initializers first in the order they will run. If one thread reaches an address another is already compiling, it waits instead of duplicating the work. This lets the JIT prepare some code before the guest reaches it.

The larger change was a near-full-binary cache mapped in place. Each image's cache is split into parts. Part 0 is the hot part - everything earlier runs executed, plus everything start-up touches - compiled at full quality and committed the moment it's ready, so a launch can start using it while the rest is still building. Cold code lands in later parts at the `fast` tier and gets upgraded at runtime, exactly like JIT code, if it ever actually runs. The files are memory-mapped and executed from their own pages rather than copied into memory, with regions published lazily the first time the run reaches each one. On macOS we pay the code-signing validation cost once at build time instead of on the first launch. And a run will kick off a background rebuild when a program's profile has drifted far enough from what its cache was built from. On macOS, we use the efficiency-core background band, on other operating systems we use the lowest priority `nice` value we can muster.

To really show the difference this made, this is Roblox booting to RenderView on a 24 GB M4 Mac, before and after the changes:

| | before | after |
|---|---|---|
| No AOT cache | 109 s, 15 GB RSS | 9.9 s, 2.1 GB RSS |
| With AOT cache | 200 s, 15 GB RSS | 2.7–3.9 s, 0.8 GB RSS |

The uncached launch improved because the JIT itself got faster. The cached launch shows the larger gain. The earlier cache took longer than recompiling because it copied and processed too much data before the program could start. Mapping cache parts in place and publishing regions only when needed removes most of that start-up work. In this measurement, cold start fell from 200 seconds to under four, and peak memory dropped from 15 GB to 0.8 GB.

The cache is the latest use for a lifter that began in an unusual place. Euryphaessa needed Microlift to change a function's structure without changing what it did. Rosemary now relies on the same precision to save compiled code and reuse it on the next launch. On Roblox, that brings a cached cold start down from 200 seconds to a few seconds.

That's a lot of divergence in the opposite direction for something that originally started out as making code worse.
