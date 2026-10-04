---
title: "Rosemary, Nullscape, and a rather expensive rounding error"
date: 2026-10-02
tags: [software engineering, rosemary, metal, vulkan, shader translation, roblox]
---

In [the last Rosemary post]({% post_url 2026-09-10-rosemary %}), we got to show Roblox running through our Metal to Vulkan translation. An actual game, with actual graphics! Naturally, the next step was to find a game that made those graphics look absolutely awful.

Nullscape was quite good at that.

Depending on the GPU and driver, its world could look like someone had deep fried the entire image, or its models could lose their color altogether. The game was running, the geometry was there, and the UI was perfectly happy. The part where you could actually see what you were playing was having a much worse time.

<figure>
  <img src="{{ '/assets/post_images/nullscape_metal_before.png' | relative_url }}" alt="Nullscape before the mix fix, with harsh blue and magenta artifacts across the world geometry" loading="lazy" width="1136" height="745">
  <figcaption>Nullscape before the fix. It is supposed to have an unusual art style, but this was taking things a little too far.</figcaption>
</figure>

We fixed this in [commit `efcc209`](https://github.com/microlift/rosemary/commit/efcc20956a2c13b895dd7a80b3a5f88b47b9b68e). While the change itself is small, getting from that broken image to the arithmetic responsible for it was considerably more interesting.

## A familiar-looking disaster

One particularly funny detail is that I'd already seen this problem in another project I work on: [Sober](https://github.com/vinegarhq/sober), which runs the Android Roblox client on Linux.

There are several reports of it in our issue tracker. [#1121](https://github.com/vinegarhq/sober/issues/1121) describes Nullscape becoming practically impossible to see without legacy rendering. Its screenshot is a fairly good demonstration of what "impossible to see" means here:

<figure>
  <img src="{{ '/assets/post_images/sober-1121-nullscape.png' | relative_url }}" alt="Nullscape in Sober with almost the entire world black, while menus, player names, and a few particles remain visible" loading="lazy" width="2560" height="1440">
  <figcaption>Screenshot by wisheth in <a href="https://github.com/vinegarhq/sober/issues/1121">Sober #1121</a>. The UI is there, most of the world might as well not be.</figcaption>
</figure>

[#1762](https://github.com/vinegarhq/sober/issues/1762) reports the same problem, with the game becoming visible when its "peculiar graphics mode" option is enabled. The report includes screenshots with the option off and on; this is the latter:

<figure>
  <img src="{{ '/assets/post_images/sober-1762-peculiar.png' | relative_url }}" alt="Nullscape in Sober with peculiar graphics mode enabled, revealing blue and green world geometry beside the game's settings menu" loading="lazy" width="2560" height="1440">
  <figcaption>Screenshot by valkyrieglasc in <a href="https://github.com/vinegarhq/sober/issues/1762">Sober #1762</a>, using the game's peculiar graphics mode. A workaround that lets you see the level is quite useful when the alternative is a black screen!</figcaption>
</figure>

And [#1974](https://github.com/vinegarhq/sober/issues/1974) describes a related fog-color problem on NVIDIA, with an apparent intensity difference of around 85 times and different results when using OpenGL. That looked like a color-scaling problem from the outside, so we were pretty tempted to just mark this as an NVIDIA issue. Spoiler alert for those unexperienced in graphics programming: it's rarely ever the driver's fault, even if NVIDIA has historically made some pretty mid-tier Linux drivers. The shader captures would give us a much more direct explanation for how a perfectly valid model color could disappear.

Sober uses Roblox's official Vulkan renderer through the Android client. Rosemary runs the Mac client and translates its Metal usage to Vulkan. Two different clients, two different routes to the GPU, and a very familiar-looking broken image at the end. That ended up being an incredibly useful clue.

## What on earth are they doing with the fog?

The investigation started with a lot of scouring Roblox DevForum posts. Nullscape's rendering involves tricks with fog and custom 3D skyboxes, and understanding what the game was asking the renderer to do seemed rather important before accusing our renderer of doing it wrong.

The skybox problem has some history. Developers put distant geometry or a ViewportFrame projection behind the playable world, then discover that the engine's fog washes out the thing they're trying to use as a skybox. The [request for a FogInfluence property](https://devforum.roblox.com/t/foginfluence-property/350321) explains that problem quite well: you want the skybox behind the world, but you also want it to keep its own colors.

That rabbit hole led to the trick I was looking for: pushing the fog settings into NaN territory so custom 3D skyboxes would render properly. Yes, deliberately feeding the renderer a value whose name literally means "Not a Number." Game developers are very resourceful when the engine doesn't expose the control they need!

There is a related family of tricks using enormous fog colors to get a posterized look. [This DevForum discussion](https://devforum.roblox.com/t/posterize-effect/2066413/15) describes using large `FogColor` values and warns that the result can differ between graphics APIs. Even when the result looks intentional, there is quite a lot of unusual floating-point behavior underneath it.

Distinguishing the two is important here: the value that exposed our `mix` bug was a huge **finite** fog color. The regression test uses `3,844,675.0`. NaN fog settings were part of the trail that led me there, and losing precision while blending a finite value in the millions was the failure we actually fixed.

## Following a pixel back to Metal

With that context, I used RenderDoc's pixel history to follow a broken pixel back to the draw that produced it. That led to the fragment shader Roblox uses to render world models. Then came tracing the offending calculation back up our translation pipeline to find out how it had ended up in the shader we handed Vulkan.

Eventually, the interesting operation was a blend: Metal's `mix`.

For ordinary values, this is about as unremarkable as shader math gets. You have two values, `x` and `y`, and a weight, `a`. At one end you want `x`; at the other you want `y`; in between you want a blend of them. In this shader, that meant blending a fog color with the model's color.

Our translator represented the operation as `FloatMix`, then emitted the `FMix` extended instruction from `GLSL.std.450`. Metal has mix, SPIR-V has something called FMix, seems like a fairly reasonable mapping, right?

It was reasonable enough to get plenty of games rendering. It also left the evaluation of that blend to the driver, and the form it chose mattered a lot more than we'd accounted for.

## Equivalent math, very different pixels

The [SPIR-V definition of `FMix`](https://registry.khronos.org/SPIR-V/specs/unified1/GLSL.std.450.html) describes a linear blend:

```c
x * (1 - a) + y * a
```

The NVIDIA path we investigated evaluated that blend in this form:

```c
x + (y - x) * a
```

On paper, those expressions are equivalent. Floating-point arithmetic has a rather important objection to that word "equivalent," though.

A 32-bit float has a fixed budget of significant binary digits, roughly enough for seven decimal digits. It can represent enormous numbers, but the gaps between the numbers it can represent grow with their magnitude. Near zero, those gaps are tiny. Out in the millions, you can lose an entire small color value between two neighboring floats. Arithmetic rounds intermediate results to fit that budget, so rearranging an equation changes where information can disappear. Algebra assumes we can carry every digit through the calculation; the GPU has rather less space available!

If you've ever traveled absurdly far from the origin in a game and watched the geometry start to jitter, warp, or twist, you've seen [the same precision limit applied to world coordinates](https://docs.godotengine.org/en/stable/tutorials/physics/large_world_coordinates.html). A vertex's small local offset gets combined with a huge position, and the resulting float can no longer distinguish all those fine details. Nearby vertices snap to a coarser grid, and moving the camera can make surfaces wobble. Here, the enormous fog color plays the role of that distant world position, and the model color is the little detail we're trying to preserve.

Floats can also appear to break down over time. Repeated updates can accumulate rounding error, while an ever-growing elapsed-time counter eventually becomes too coarse to represent small time steps reliably. A stored float doesn't deteriorate just because time passes; the trouble comes from the calculations and the scale of the values involved. Our fog blend manages to hit that same limitation in a single calculation.

Take the values from the regression test:

```c
x = 3844675.0f;
y = 0.02f;
a = 1.0f;
```

At a weight of one, we need the model color, `y`. But a 32-bit float around 3.8 million has a spacing of `0.25` between adjacent representable values. Our little `0.02` color is much smaller than that spacing. Subtracting `x` from it rounds away the part we wanted to keep:

```c
y - x          // rounds to -3844675.0f
x + (y - x)    // becomes 0.0f
```

Evaluating the spec's `x * (1 - a) + y * a` as separate operations avoids that loss at this endpoint. With `a = 1`, the enormous `x` is multiplied by zero, while `y` is multiplied by one: `0 + y`. In the NVIDIA form, `y` has already disappeared when `y - x` is rounded. Adding `x` back cancels the large value, but it cannot recover the small value we threw away. The formulas agree in exact arithmetic; their floating-point intermediate results do not.

We asked for a dark color and got black. With other values, we got coarse steps in the color instead. Later rendering passes amplified the damage into that spectacularly deep fried image. In the worst case, every color channel went away and the world models turned black.

This wasn't a matter of changing the shader from a 32-bit float to a smaller type. The intermediate subtraction was operating at the scale of the fog color, and the precision available at that scale wasn't enough to retain the model color. Getting a recognizable image on one driver had hidden how much behavior we'd left unspecified in our translation.

The behavior Roblox's Metal shader relied on was being lost in our mapping to `FMix`. A similar name and an equivalent real-number formula weren't enough to preserve it.

## Making the arithmetic explicit

The fix replaces that `FMix` emission with four explicit SPIR-V arithmetic instructions, corresponding to:

```c
(x - x * a) + y * a
```

For these finite inputs at `a = 1`, `x * a` is exactly `x`, so the first part cancels to zero. The small `y` value is multiplied separately and survives. At `a = 0`, the expression gives us `x`. We preserve the endpoint behavior that this shader needs without subtracting the tiny model color from the enormous fog color.

There is another important part to the change: all four arithmetic results carry SPIR-V's `NoContraction` decoration. Choosing the arithmetic is only useful if the driver keeps the separate operations we emitted. We don't want an optimization to combine them and undo the precision behavior we just went to the trouble of preserving.

We also added `mix_is_exact_at_its_endpoints`, a regression test built around the large fog color and the small model color above. It checks the emitted SPIR-V to ensure we don't have `FMix`, the four arithmetic operations are present, and `NoContraction` is present on every one.

<figure>
  <img src="{{ '/assets/post_images/nullscape_metal_after.png' | relative_url }}" alt="Nullscape after the mix fix, with visible model colors, floor tiles, and the purple skybox" loading="lazy" width="1142" height="871">
  <figcaption>Nullscape after the fix. Still a very purple place, but now you can actually see it!</figcaption>
</figure>

## Roblox made the same mistake

And here's the funny part: the official renderer stumbled upon the same problem from the other direction.

Roblox's shader packs go through HLSL to GLSL translation for its OpenGL and Vulkan paths. On Android, every world fragment shader ends with the same fog blend, represented in the shader disassembly as:

```c
FMix(CB0[11].xyz, lit, fogFactor)
```

`CB0` is a constant buffer supplying the shader's parameters, `CB0[11].xyz` is the fog color, and `lit` is the model color after lighting. The shader has done all that work to calculate a color, then hands it to precisely the operation that was losing it in Rosemary.

In Nullscape, the relevant values are:

```c
CB0[11].xyz = (3844675, 3844675, 153787); // fog color
CB0[10]     = (984615.4, 0, -9.85, 1);   // fog parameters
```

Those fog parameters make `fogFactor` clamp to exactly `1`. With the fog color as the first input and `lit` as the second, that is supposed to mean **no fog**: return the lit color unchanged. The enormous fog color should have no contribution at all.

Instead, NVIDIA's `x + (y - x) * a` evaluation makes the supposedly unused fog color determine how much precision survives. Red and green are being subtracted from `3,844,675`, so their values come back in steps of `0.25`. Our `0.02` example becomes zero; other small colors can jump to `0.25`. Simply asking for "no fog" has turned into a rather aggressive color quantizer.

Blue has an interesting advantage here. Its fog value, `153,787`, is 25 times smaller than the red and green values. The spacing between 32-bit floats at that magnitude is `0.015625`, rather than `0.25`. For the same illustrative lit value of `0.02`, this evaluation keeps `0.015625` in blue while red and green both become zero. The precision difference follows the floats' binary exponent, so the 25-fold difference in magnitude gives us 16 times finer steps in this case.

That explains the mostly black frame with its surviving blue and purple tint, and why green was particularly weak in the broken output. Mesa continues to produce a mostly usable image from these Android shaders, though with minor defects such as weak green cones. The driver's evaluation of the blend decides whether we're looking at a slightly wrong color or a world we can barely see.

<figure>
  <img src="{{ '/assets/post_images/sober-1974-vulkan.png' | relative_url }}" alt="Nullscape using the Vulkan path in Sober, with world surfaces nearly black and only faint purple geometry and bright particles visible" loading="lazy" width="1563" height="835">
  <figcaption>The Vulkan screenshot from <a href="https://github.com/vinegarhq/sober/issues/1974">Sober #1974</a>, reported by n0luh. Most of the world color has disappeared, leaving faint purple shapes and a few bright effects.</figcaption>
</figure>

<figure>
  <img src="{{ '/assets/post_images/sober-1974-opengl.png' | relative_url }}" alt="Nullscape using the reported OpenGL workaround in Sober, with visible world geometry but harsh blue and magenta color artifacts" loading="lazy" width="1569" height="833">
  <figcaption>The same reporter's OpenGL screenshot in <a href="https://github.com/vinegarhq/sober/issues/1974">Sober #1974</a>. The world is visible again, but the colors still have obvious artifacts. Looks radical! Not accurate to the game's actual rendering, though.</figcaption>
</figure>

We took Metal to Vulkan, while Roblox took its HLSL shaders from the D3D11 side through GLSL to Vulkan. Both routes ended up using `FMix` for a blend whose precision the game depended on. We had managed to make the same mistake independently. Quite an impressive amount of agreement between two broken renderers!

That explains why this showed up in Sober even though Sober wasn't doing anything special for Vulkan support. The Android client already contained the problematic shader path. Fixing our translator doesn't rewrite Roblox's official Vulkan shader packs, so it doesn't automatically fix those Sober reports. It does explain why the same game could fail in such a similar way in both projects.

There was an extra twist on native macOS: Apple's OpenGL renderer internally translates OpenGL to Metal, their SPIRV to AIR translator mapped the FMix back to Metal's mix, preserving the behavior Roblox expected. We'd mapped Metal's mix to the operation that lost it, while Apple went back the other way and happened to keep it working. That is a fairly amusing way for a translation bug to hide.

## A few more Metal details

The mix fix was its own commit, but it sits alongside some other accuracy work in our Metal implementation. These aren't all dramatic enough to turn a whole game purple, but they are exactly the sort of details applications quietly depend on.

In [the depth-bias fix](https://github.com/microlift/rosemary/commit/aa2476fbbc98527b39d2b169b629fca98f55a4cd), we were setting bias values without enabling depth bias in the Vulkan rasterization state. Depth bias offsets the depth used by a draw, often to keep closely overlapping surfaces from fighting over which one is visible. Passing along the values is considerably less useful when the switch that makes them do anything is off. One line fixed that. Sometimes the bug really is that small!

[The signed-input fix](https://github.com/microlift/rosemary/commit/5bb98bbe021c3d30909a175040339a15ec4bab8b) was a subtler translation problem. AIR, Apple's shader intermediate representation, carries integer values without signedness on the integer type itself. Vulkan still needs the shader's integer image types and vertex inputs to match the signedness of their formats. We now retain that information from Metal's metadata, declare the appropriate signed inputs, and bitcast the loaded values back into the representation the shader body uses. Keeping the same bits isn't sufficient if the interface declares the wrong interpretation of those bits.

And [the compressed-texture copy fix](https://github.com/microlift/rosemary/commit/6c54375091e42ddd3db3be0de74d8f956ecb6313) addressed the tiny end of a mip chain. A block-compressed texture can have a mip level only 2 by 2 or even 1 by 1 texels wide, while its data still occupies a whole 4 by 4 compression block. Metal can describe that whole block for a copy at the edge. Vulkan needs the copy extent to stop at the actual mip boundary. We now clamp the extent accordingly, including checking both images for texture-to-texture copies, instead of handing Vulkan a region that runs past the level.

These fixes all come back to the same practical problem we ran into in the first Rosemary post: calling something that looks like the right API isn't enough. The application needs the behavior it asked for, including the details that are very easy to miss when your test scene happens to render correctly.

This time, one of those details was a dark color trying to survive a subtraction against nearly four million.

Quite a lot of debugging for `0.02`.
