/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "base/histogram.h"
#include "ImageLogging.h"
#include "nsComponentManagerUtils.h"
#include "imgDecoderObserver.h"
#include "nsError.h"
#include "Decoder.h"
#include "RasterImage.h"
#include "nsIInterfaceRequestor.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIMultiPartChannel.h"
#include "nsAutoPtr.h"
#include "nsStringStream.h"
#include "prenv.h"
#include "prsystem.h"
#include "ImageContainer.h"
#include "Layers.h"
#include "nsPresContext.h"
#include "nsThread.h"
#include "nsIThreadPool.h"
#include "nsXPCOMCIDInternal.h"
#include "nsIObserverService.h"

#include "nsPNGDecoder.h"
#include "nsGIFDecoder2.h"
#include "nsJPEGDecoder.h"
#include "nsBMPDecoder.h"
#include "nsICODecoder.h"
#include "nsIconDecoder.h"

#ifdef MOZ_WBMP
#include "nsWBMPDecoder.h"
#endif

#include "gfxContext.h"

#include "mozilla/Services.h"
#include "mozilla/Preferences.h"
#include "mozilla/StandardInteger.h"
#include "mozilla/Telemetry.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/gfx/Scale.h"

#include "GeckoProfiler.h"
#include <algorithm>

using namespace mozilla;
using namespace mozilla::image;
using namespace mozilla::layers;

// a mask for flags that will affect the decoding
#define DECODE_FLAGS_MASK (imgIContainer::FLAG_DECODE_NO_PREMULTIPLY_ALPHA | imgIContainer::FLAG_DECODE_NO_COLORSPACE_CONVERSION)
#define DECODE_FLAGS_DEFAULT 0

/* Accounting for compressed data */
#if defined(PR_LOGGING)
static PRLogModuleInfo *
GetCompressedImageAccountingLog()
{
  static PRLogModuleInfo *sLog;
  if (!sLog)
    sLog = PR_NewLogModule("CompressedImageAccounting");
  return sLog;
}
#else
#define GetCompressedImageAccountingLog()
#endif

// Tweakable progressive decoding parameters.  These are initialized to 0 here
// because otherwise, we have to initialize them in a static initializer, which
// makes us slower to start up.
static uint32_t gDecodeBytesAtATime = 0;
static uint32_t gMaxMSBeforeYield = 0;
static bool gHQDownscaling = false;
// This is interpreted as a floating-point value / 1000
static uint32_t gHQDownscalingMinFactor = 1000;
static bool gMultithreadedDecoding = true;
static int32_t gDecodingThreadLimit = -1;
// The number of pixels in a 5 megapixel decoded image.
// Equivalent to an example 3125x1600 resolution.
static uint32_t gHQUpscalingMaxSize = 20971520;

// The maximum number of times any one RasterImage was decoded.  This is only
// used for statistics.
static int32_t sMaxDecodeCount = 0;

static void
InitPrefCaches()
{
  Preferences::AddUintVarCache(&gDecodeBytesAtATime,
                               "image.mem.decode_bytes_at_a_time", 200000);
  Preferences::AddUintVarCache(&gMaxMSBeforeYield,
                               "image.mem.max_ms_before_yield", 400);
  Preferences::AddBoolVarCache(&gHQDownscaling,
                               "image.high_quality_downscaling.enabled", false);
  Preferences::AddUintVarCache(&gHQDownscalingMinFactor,
                               "image.high_quality_downscaling.min_factor", 1000);
  Preferences::AddBoolVarCache(&gMultithreadedDecoding,
                               "image.multithreaded_decoding.enabled", true);
  Preferences::AddIntVarCache(&gDecodingThreadLimit,
                              "image.multithreaded_decoding.limit", -1);
  Preferences::AddUintVarCache(&gHQUpscalingMaxSize,
                               "image.high_quality_upscaling.max_size", 20971520);
}

/* We define our own error checking macros here for 2 reasons:
 *
 * 1) Most of the failures we encounter here will (hopefully) be
 * the result of decoding failures (ie, bad data) and not code
 * failures. As such, we don't want to clutter up debug consoles
 * with spurious messages about NS_ENSURE_SUCCESS failures.
 *
 * 2) We want to set the internal error flag, shutdown properly,
 * and end up in an error state.
 *
 * So this macro should be called when the desired failure behavior
 * is to put the container into an error state and return failure.
 * It goes without saying that macro won't compile outside of a
 * non-static RasterImage method.
 */
#define LOG_CONTAINER_ERROR                      \
  PR_BEGIN_MACRO                                 \
  PR_LOG (GetImgLog(), PR_LOG_ERROR,             \
          ("RasterImage: [this=%p] Error "      \
           "detected at line %u for image of "   \
           "type %s\n", this, __LINE__,          \
           mSourceDataMimeType.get()));          \
  PR_END_MACRO

#define CONTAINER_ENSURE_SUCCESS(status)      \
  PR_BEGIN_MACRO                              \
  nsresult _status = status; /* eval once */  \
  if (NS_FAILED(_status)) {                   \
    LOG_CONTAINER_ERROR;                      \
    DoError();                                \
    return _status;                           \
  }                                           \
 PR_END_MACRO

#define CONTAINER_ENSURE_TRUE(arg, rv)  \
  PR_BEGIN_MACRO                        \
  if (!(arg)) {                         \
    LOG_CONTAINER_ERROR;                \
    DoError();                          \
    return rv;                          \
  }                                     \
  PR_END_MACRO



static int num_containers;
static int num_discardable_containers;
static int64_t total_source_bytes;
static int64_t discardable_source_bytes;

/* Are we globally disabling image discarding? */
static bool
DiscardingEnabled()
{
  static bool inited;
  static bool enabled;

  if (!inited) {
    inited = true;

    enabled = (PR_GetEnv("MOZ_DISABLE_IMAGE_DISCARD") == nullptr);
  }

  return enabled;
}

class ScaleRequest
{
public:
  ScaleRequest(RasterImage* aImage, const gfxSize& aScale, imgFrame* aSrcFrame)
    : scale(aScale)
    , dstLocked(false)
    , done(false)
    , stopped(false)
  {
    MOZ_ASSERT(!aSrcFrame->GetIsPaletted());
    MOZ_ASSERT(aScale.width > 0 && aScale.height > 0);

    weakImage = aImage->asWeakPtr();
    srcRect = aSrcFrame->GetRect();

    nsIntRect dstRect = srcRect;
    dstRect.ScaleRoundOut(scale.width, scale.height);
    dstSize = dstRect.Size();
  }

  // This can only be called on the main thread.
  bool GetSurfaces(imgFrame* srcFrame)
  {
    MOZ_ASSERT(NS_IsMainThread());

    nsRefPtr<RasterImage> image = weakImage.get();
    if (!image) {
      return false;
    }

    bool success = false;
    if (!dstLocked) {
      bool srcLocked = NS_SUCCEEDED(srcFrame->LockImageData());
      dstLocked = NS_SUCCEEDED(dstFrame->LockImageData());

      nsRefPtr<gfxASurface> dstASurf;
      nsRefPtr<gfxASurface> srcASurf;
      success = srcLocked && NS_SUCCEEDED(srcFrame->GetSurface(getter_AddRefs(srcASurf)));
      success = success && dstLocked && NS_SUCCEEDED(dstFrame->GetSurface(getter_AddRefs(dstASurf)));

      success = success && srcLocked && dstLocked && srcASurf && dstASurf;

      if (success) {
        srcSurface = srcASurf->GetAsImageSurface();
        dstSurface = dstASurf->GetAsImageSurface();
        srcData = srcSurface->Data();
        dstData = dstSurface->Data();
        srcStride = srcSurface->Stride();
        dstStride = dstSurface->Stride();
        srcFormat = mozilla::gfx::ImageFormatToSurfaceFormat(srcFrame->GetFormat());
      }

      // We have references to the Thebes surfaces, so we don't need to leave
      // the source frame (that we don't own) locked. We'll unlock the
      // destination frame in ReleaseSurfaces(), below.
      if (srcLocked) {
        success = NS_SUCCEEDED(srcFrame->UnlockImageData()) && success;
      }

      success = success && srcSurface && dstSurface;
    }

    return success;
  }

  // This can only be called on the main thread.
  bool ReleaseSurfaces()
  {
    MOZ_ASSERT(NS_IsMainThread());

    nsRefPtr<RasterImage> image = weakImage.get();
    if (!image) {
      return false;
    }

    bool success = false;
    if (dstLocked) {
      success = NS_SUCCEEDED(dstFrame->UnlockImageData());

      dstLocked = false;
      srcData = nullptr;
      dstData = nullptr;
      srcSurface = nullptr;
      dstSurface = nullptr;
    }
    return success;
  }

  // These values may only be touched on the main thread.
  WeakPtr<RasterImage> weakImage;
  nsAutoPtr<imgFrame> dstFrame;
  nsRefPtr<gfxImageSurface> srcSurface;
  nsRefPtr<gfxImageSurface> dstSurface;

  // Below are the values that may be touched on the scaling thread.
  gfxSize scale;
  uint8_t* srcData;
  uint8_t* dstData;
  nsIntRect srcRect;
  gfxIntSize dstSize;
  uint32_t srcStride;
  uint32_t dstStride;
  mozilla::gfx::SurfaceFormat srcFormat;
  bool dstLocked;
  bool done;
  // This boolean is accessed from both threads simultaneously without locking.
  // That's safe because stopping a ScaleRequest is strictly an optimization;
  // if we're not cache-coherent, at worst we'll do extra work.
  bool stopped;
};

class DrawRunner : public nsRunnable
{
public:
  DrawRunner(ScaleRequest* request)
   : mScaleRequest(request)
  {}

  NS_IMETHOD Run()
  {
    // ScaleWorker is finished with this request, so we can unlock the data now.
    mScaleRequest->ReleaseSurfaces();

    nsRefPtr<RasterImage> image = mScaleRequest->weakImage.get();

    if (image) {
      RasterImage::ScaleStatus status;
      if (mScaleRequest->done) {
        status = RasterImage::SCALE_DONE;
      } else {
        status = RasterImage::SCALE_INVALID;
      }

      image->ScalingDone(mScaleRequest, status);
    }

    return NS_OK;
  }

private: /* members */
  nsAutoPtr<ScaleRequest> mScaleRequest;
};

class ScaleRunner : public nsRunnable
{
public:
  ScaleRunner(RasterImage* aImage, const gfxSize& aScale, imgFrame* aSrcFrame)
  {
    nsAutoPtr<ScaleRequest> request(new ScaleRequest(aImage, aScale, aSrcFrame));

    // Destination is unconditionally ARGB32 because that's what the scaler
    // outputs.
    request->dstFrame = new imgFrame();
    nsresult rv = request->dstFrame->Init(0, 0, request->dstSize.width, request->dstSize.height,
                                          gfxASurface::ImageFormatARGB32);

    if (NS_FAILED(rv) || !request->GetSurfaces(aSrcFrame)) {
      return;
    }

    aImage->ScalingStart(request);

    mScaleRequest = request;
  }

  NS_IMETHOD Run()
  {
    // An alias just for ease of typing
    ScaleRequest* request = mScaleRequest;

    if (!request->stopped) {
      request->done = mozilla::gfx::Scale(request->srcData, request->srcRect.width, request->srcRect.height, request->srcStride,
                                          request->dstData, request->dstSize.width, request->dstSize.height, request->dstStride,
                                          request->srcFormat);
    } else {
      request->done = false;
    }

    // OK, we've got a new scaled image. Let's get the main thread to unlock and
    // redraw it.
    nsRefPtr<DrawRunner> runner = new DrawRunner(mScaleRequest.forget());
    NS_DispatchToMainThread(runner, NS_DISPATCH_NORMAL);

    return NS_OK;
  }

  bool IsOK() const { return !!mScaleRequest; }

private:
  nsAutoPtr<ScaleRequest> mScaleRequest;
};

namespace mozilla {
namespace image {

/* static */ StaticRefPtr<RasterImage::DecodePool> RasterImage::DecodePool::sSingleton;
static nsCOMPtr<nsIThread> sScaleWorkerThread = nullptr;

#ifndef DEBUG
NS_IMPL_THREADSAFE_ISUPPORTS2(RasterImage, imgIContainer, nsIProperties)
#else
NS_IMPL_THREADSAFE_ISUPPORTS3(RasterImage, imgIContainer, nsIProperties,
                              imgIContainerDebug)
#endif

//******************************************************************************
RasterImage::RasterImage(imgStatusTracker* aStatusTracker,
                         nsIURI* aURI /* = nullptr */) :
  ImageResource(aStatusTracker, aURI), // invoke superclass's constructor
  mSize(0,0),
  mFrameDecodeFlags(DECODE_FLAGS_DEFAULT),
  mMultipartDecodedFrame(nullptr),
  mAnim(nullptr),
  mLoopCount(-1),
  mLockCount(0),
  mDecodeCount(0),
#ifdef DEBUG
  mFramesNotified(0),
#endif
  mDecodingMutex("RasterImage"),
  mDecoder(nullptr),
  mBytesDecoded(0),
  mInDecoder(false),
  mHasSize(false),
  mDecodeOnDraw(false),
  mMultipart(false),
  mDiscardable(false),
  mHasSourceData(false),
  mDecoded(false),
  mHasBeenDecoded(false),
  mAnimationFinished(false),
  mFinishing(false),
  mInUpdateImageContainer(false),
  mWantFullDecode(false),
  mScaleRequest(nullptr)
{
  // Set up the discard tracker node.
  mDiscardTrackerNode.img = this;
  Telemetry::GetHistogramById(Telemetry::IMAGE_DECODE_COUNT)->Add(0);

  // Statistics
  num_containers++;
}

//******************************************************************************
RasterImage::~RasterImage()
{
  // Discardable statistics
  if (mDiscardable) {
    num_discardable_containers--;
    discardable_source_bytes -= mSourceData.Length();

    PR_LOG (GetCompressedImageAccountingLog(), PR_LOG_DEBUG,
            ("CompressedImageAccounting: destroying RasterImage %p.  "
             "Total Containers: %d, Discardable containers: %d, "
             "Total source bytes: %lld, Source bytes for discardable containers %lld",
             this,
             num_containers,
             num_discardable_containers,
             total_source_bytes,
             discardable_source_bytes));
  }

  if (mDecoder) {
    // Kill off our decode request, if it's pending.  (If not, this call is
    // harmless.)
    MutexAutoLock lock(mDecodingMutex);
    DecodePool::StopDecoding(this);
    mDecoder = nullptr;

    // Unlock the last frame (if we have any). Our invariant is that, while we
    // have a decoder open, the last frame is always locked.
    // This would be done in ShutdownDecoder, but since mDecoder is non-null,
    // we didn't call ShutdownDecoder and we need to do it manually.
    if (mFrames.Length() > 0) {
      imgFrame *curframe = mFrames.ElementAt(mFrames.Length() - 1);
      curframe->UnlockImageData();
    }
  }

  delete mAnim;

  for (unsigned int i = 0; i < mFrames.Length(); ++i)
    delete mFrames[i];

  delete mMultipartDecodedFrame;

  // Total statistics
  num_containers--;
  total_source_bytes -= mSourceData.Length();

  if (NS_IsMainThread()) {
    DiscardTracker::Remove(&mDiscardTrackerNode);
  }
}

/* static */ void
RasterImage::Initialize()
{
  InitPrefCaches();

  // Create our singletons now, so we don't have to worry about what thread
  // they're created on.
  DecodePool::Singleton();
}

nsresult
RasterImage::Init(const char* aMimeType,
                  uint32_t aFlags)
{
  // We don't support re-initialization
  if (mInitialized)
    return NS_ERROR_ILLEGAL_VALUE;

  // Not sure an error can happen before init, but be safe
  if (mError)
    return NS_ERROR_FAILURE;

  NS_ENSURE_ARG_POINTER(aMimeType);

  // We must be non-discardable and non-decode-on-draw for
  // multipart channels
  NS_ABORT_IF_FALSE(!(aFlags & INIT_FLAG_MULTIPART) ||
                    (!(aFlags & INIT_FLAG_DISCARDABLE) &&
                     !(aFlags & INIT_FLAG_DECODE_ON_DRAW)),
                    "Can't be discardable or decode-on-draw for multipart");

  // Store initialization data
  mSourceDataMimeType.Assign(aMimeType);
  mDiscardable = !!(aFlags & INIT_FLAG_DISCARDABLE);
  mDecodeOnDraw = !!(aFlags & INIT_FLAG_DECODE_ON_DRAW);
  mMultipart = !!(aFlags & INIT_FLAG_MULTIPART);

  // Statistics
  if (mDiscardable) {
    num_discardable_containers++;
    discardable_source_bytes += mSourceData.Length();
  }

  // Instantiate the decoder
  nsresult rv = InitDecoder(/* aDoSizeDecode = */ true);
  CONTAINER_ENSURE_SUCCESS(rv);

  // If we aren't storing source data, we want to switch from a size decode to
  // a full decode as soon as possible.
  if (!StoringSourceData()) {
    mWantFullDecode = true;
  }

  // Mark us as initialized
  mInitialized = true;

  return NS_OK;
}

bool
RasterImage::AdvanceFrame(TimeStamp aTime, nsIntRect* aDirtyRect)
{
  NS_ASSERTION(aTime <= TimeStamp::Now(),
               "Given time appears to be in the future");

  imgFrame* nextFrame = nullptr;
  uint32_t currentFrameIndex = mAnim->currentAnimationFrameIndex;
  uint32_t nextFrameIndex = mAnim->currentAnimationFrameIndex + 1;
  uint32_t timeout = 0;

  // Figure out if we have the next full frame. This is more complicated than
  // just checking for mFrames.Length() because decoders append their frames
  // before they're filled in.
  NS_ABORT_IF_FALSE(mDecoder || nextFrameIndex <= mFrames.Length(),
                    "How did we get 2 indices too far by incrementing?");

  // If we don't have a decoder, we know we've got everything we're going to
  // get. If we do, we only display fully-downloaded frames; everything else
  // gets delayed.
  bool haveFullNextFrame = (mMultipart && mBytesDecoded == 0) || !mDecoder ||
                           nextFrameIndex < mDecoder->GetCompleteFrameCount();

  // If we're done decoding the next frame, go ahead and display it now and
  // reinit with the next frame's delay time.
  if (haveFullNextFrame) {
    if (mFrames.Length() == nextFrameIndex) {
      // End of Animation, unless we are looping forever

      // If animation mode is "loop once", it's time to stop animating
      if (mAnimationMode == kLoopOnceAnimMode || mLoopCount == 0) {
        mAnimationFinished = true;
        EvaluateAnimation();
      }

      // We may have used compositingFrame to build a frame, and then copied
      // it back into mFrames[..].  If so, delete composite to save memory
      if (mAnim->compositingFrame && mAnim->lastCompositedFrameIndex == -1) {
        mAnim->compositingFrame = nullptr;
      }

      nextFrameIndex = 0;

      if (mLoopCount > 0) {
        mLoopCount--;
      }

      if (!mAnimating) {
        // break out early if we are actually done animating
        return false;
      }
    }

    if (!(nextFrame = mFrames[nextFrameIndex])) {
      // something wrong with the next frame, skip it
      mAnim->currentAnimationFrameIndex = nextFrameIndex;
      return false;
    }

    timeout = nextFrame->GetTimeout();

  } else {
    // Uh oh, the frame we want to show is currently being decoded (partial)
    // Wait until the next refresh driver tick and try again
    return false;
  }

  if (!(timeout > 0)) {
    mAnimationFinished = true;
    EvaluateAnimation();
  }

  if (nextFrameIndex == 0) {
    *aDirtyRect = mAnim->firstFrameRefreshArea;
  } else {
    imgFrame *curFrame = mFrames[currentFrameIndex];

    if (!curFrame) {
      return false;
    }

    // Change frame
    if (NS_FAILED(DoComposite(aDirtyRect, curFrame,
                              nextFrame, nextFrameIndex))) {
      // something went wrong, move on to next
      NS_WARNING("RasterImage::AdvanceFrame(): Compositing of frame failed");
      nextFrame->SetCompositingFailed(true);
      mAnim->currentAnimationFrameIndex = nextFrameIndex;
      mAnim->currentAnimationFrameTime = aTime;
      return false;
    }

    nextFrame->SetCompositingFailed(false);
  }

  // Set currentAnimationFrameIndex at the last possible moment
  mAnim->currentAnimationFrameIndex = nextFrameIndex;
  mAnim->currentAnimationFrameTime = aTime;

  return true;
}

//******************************************************************************
// [notxpcom] void requestRefresh ([const] in TimeStamp aTime);
NS_IMETHODIMP_(void)
RasterImage::RequestRefresh(const mozilla::TimeStamp& aTime)
{
  if (!mAnimating || !ShouldAnimate()) {
    return;
  }

  EnsureAnimExists();

  // only advance the frame if the current time is greater than or
  // equal to the current frame's end time.
  TimeStamp currentFrameEndTime = GetCurrentImgFrameEndTime();
  bool frameAdvanced = false;

  // The dirtyRect variable will contain an accumulation of the sub-rectangles
  // that are dirty for each frame we advance in AdvanceFrame().
  nsIntRect dirtyRect;

  while (currentFrameEndTime <= aTime) {
    TimeStamp oldFrameEndTime = currentFrameEndTime;
    nsIntRect frameDirtyRect;
    bool didAdvance = AdvanceFrame(aTime, &frameDirtyRect);
    frameAdvanced = frameAdvanced || didAdvance;
    currentFrameEndTime = GetCurrentImgFrameEndTime();

    // Accumulate the dirty area.
    dirtyRect = dirtyRect.Union(frameDirtyRect);

    // if we didn't advance a frame, and our frame end time didn't change,
    // then we need to break out of this loop & wait for the frame(s)
    // to finish downloading
    if (!frameAdvanced && (currentFrameEndTime == oldFrameEndTime)) {
      break;
    }
  }

  if (frameAdvanced) {
    // Notify listeners that our frame has actually changed, but do this only
    // once for all frames that we've now passed (if AdvanceFrame() was called
    // more than once).
    #ifdef DEBUG
      mFramesNotified++;
    #endif

    UpdateImageContainer();

    // Explicitly call this on mStatusTracker so we're sure to not interfere
    // with the decoding process
    if (mStatusTracker)
      mStatusTracker->FrameChanged(&dirtyRect);
  }
}

//******************************************************************************
/* readonly attribute int32_t width; */
NS_IMETHODIMP
RasterImage::GetWidth(int32_t *aWidth)
{
  NS_ENSURE_ARG_POINTER(aWidth);

  if (mError) {
    *aWidth = 0;
    return NS_ERROR_FAILURE;
  }

  *aWidth = mSize.width;
  return NS_OK;
}

//******************************************************************************
/* readonly attribute int32_t height; */
NS_IMETHODIMP
RasterImage::GetHeight(int32_t *aHeight)
{
  NS_ENSURE_ARG_POINTER(aHeight);

  if (mError) {
    *aHeight = 0;
    return NS_ERROR_FAILURE;
  }

  *aHeight = mSize.height;
  return NS_OK;
}

//******************************************************************************
/* [noscript] readonly attribute nsSize intrinsicSize; */
NS_IMETHODIMP
RasterImage::GetIntrinsicSize(nsSize* aSize)
{
  if (mError)
    return NS_ERROR_FAILURE;

  *aSize = nsSize(nsPresContext::CSSPixelsToAppUnits(mSize.width),
                  nsPresContext::CSSPixelsToAppUnits(mSize.height));
  return NS_OK;
}

//******************************************************************************
/* [noscript] readonly attribute nsSize intrinsicRatio; */
NS_IMETHODIMP
RasterImage::GetIntrinsicRatio(nsSize* aRatio)
{
  if (mError)
    return NS_ERROR_FAILURE;

  *aRatio = nsSize(mSize.width, mSize.height);
  return NS_OK;
}

//******************************************************************************
/* unsigned short GetType(); */
NS_IMETHODIMP
RasterImage::GetType(uint16_t *aType)
{
  NS_ENSURE_ARG_POINTER(aType);

  *aType = GetType();
  return NS_OK;
}

//******************************************************************************
/* [noscript, notxpcom] uint16_t GetType(); */
NS_IMETHODIMP_(uint16_t)
RasterImage::GetType()
{
  return imgIContainer::TYPE_RASTER;
}

imgFrame*
RasterImage::GetImgFrameNoDecode(uint32_t framenum)
{
  if (!mAnim) {
    NS_ASSERTION(framenum == 0, "Don't ask for a frame > 0 if we're not animated!");
    return mFrames.SafeElementAt(0, nullptr);
  }
  if (mAnim->lastCompositedFrameIndex == int32_t(framenum))
    return mAnim->compositingFrame;
  return mFrames.SafeElementAt(framenum, nullptr);
}

imgFrame*
RasterImage::GetImgFrame(uint32_t framenum)
{
  nsresult rv = WantDecodedFrames();
  CONTAINER_ENSURE_TRUE(NS_SUCCEEDED(rv), nullptr);
  return GetImgFrameNoDecode(framenum);
}

imgFrame*
RasterImage::GetDrawableImgFrame(uint32_t framenum)
{
  imgFrame* frame = nullptr;

  if (mMultipart && framenum == GetCurrentImgFrameIndex()) {
    // In the multipart case we prefer to use mMultipartDecodedFrame, which is
    // the most recent one we completely decoded, rather than display the real
    // current frame and risk severe tearing.
    frame = mMultipartDecodedFrame;
  }

  if (!frame) {
    frame = GetImgFrame(framenum);
  }

  // We will return a paletted frame if it's not marked as compositing failed
  // so we can catch crashes for reasons we haven't investigated.
  if (frame && frame->GetCompositingFailed())
    return nullptr;
  return frame;
}

uint32_t
RasterImage::GetCurrentImgFrameIndex() const
{
  if (mAnim)
    return mAnim->currentAnimationFrameIndex;

  return 0;
}

TimeStamp
RasterImage::GetCurrentImgFrameEndTime() const
{
  imgFrame* currentFrame = mFrames[mAnim->currentAnimationFrameIndex];
  TimeStamp currentFrameTime = mAnim->currentAnimationFrameTime;
  int64_t timeout = currentFrame->GetTimeout();

  if (timeout < 0) {
    // We need to return a sentinel value in this case, because our logic
    // doesn't work correctly if we have a negative timeout value. The reason
    // this positive infinity was chosen was because it works with the loop in
    // RequestRefresh() above.
    return TimeStamp() +
           TimeDuration::FromMilliseconds(static_cast<double>(UINT64_MAX));
  }

  TimeDuration durationOfTimeout =
    TimeDuration::FromMilliseconds(static_cast<double>(timeout));
  TimeStamp currentFrameEndTime = currentFrameTime + durationOfTimeout;

  return currentFrameEndTime;
}

imgFrame*
RasterImage::GetCurrentImgFrame()
{
  return GetImgFrame(GetCurrentImgFrameIndex());
}

imgFrame*
RasterImage::GetCurrentDrawableImgFrame()
{
  return GetDrawableImgFrame(GetCurrentImgFrameIndex());
}

//******************************************************************************
/* [notxpcom] boolean frameIsOpaque(in uint32_t aWhichFrame); */
NS_IMETHODIMP_(bool)
RasterImage::FrameIsOpaque(uint32_t aWhichFrame)
{
  if (aWhichFrame > FRAME_MAX_VALUE) {
    NS_WARNING("aWhichFrame outside valid range!");
    return false;
  }

  if (mError)
    return false;

  // See if we can get an image frame.
  imgFrame* frame = aWhichFrame == FRAME_FIRST ? GetImgFrameNoDecode(0)
                                               : GetImgFrameNoDecode(GetCurrentImgFrameIndex());

  // If we don't get a frame, the safe answer is "not opaque".
  if (!frame)
    return false;

  // Other, the frame is transparent if either:
  //  1. It needs a background.
  //  2. Its size doesn't cover our entire area.
  nsIntRect framerect = frame->GetRect();
  return !frame->GetNeedsBackground() &&
         framerect.IsEqualInterior(nsIntRect(0, 0, mSize.width, mSize.height));
}

nsIntRect
RasterImage::FrameRect(uint32_t aWhichFrame)
{
  if (aWhichFrame > FRAME_MAX_VALUE) {
    NS_WARNING("aWhichFrame outside valid range!");
    return nsIntRect();
  }

  // Get the requested frame.
  imgFrame* frame = aWhichFrame == FRAME_FIRST ? GetImgFrameNoDecode(0)
                                               : GetImgFrameNoDecode(GetCurrentImgFrameIndex());

  // If we have the frame, use that rectangle.
  if (frame) {
    return frame->GetRect();
  }

  // If the frame doesn't exist, we return the empty rectangle. It's not clear
  // whether this is appropriate in general, but at the moment the only
  // consumer of this method is imgStatusTracker (when it wants to figure out
  // dirty rectangles to send out batched observer updates). This should
  // probably be revisited when we fix bug 503973.
  return nsIntRect();
}

uint32_t
RasterImage::GetCurrentFrameIndex()
{
  return GetCurrentImgFrameIndex();
}

uint32_t
RasterImage::GetNumFrames()
{
  return mFrames.Length();
}

//******************************************************************************
/* readonly attribute boolean animated; */
NS_IMETHODIMP
RasterImage::GetAnimated(bool *aAnimated)
{
  if (mError)
    return NS_ERROR_FAILURE;

  NS_ENSURE_ARG_POINTER(aAnimated);

  // If we have mAnim, we can know for sure
  if (mAnim) {
    *aAnimated = true;
    return NS_OK;
  }

  // Otherwise, we need to have been decoded to know for sure, since if we were
  // decoded at least once mAnim would have been created for animated images
  if (!mHasBeenDecoded)
    return NS_ERROR_NOT_AVAILABLE;

  // We know for sure
  *aAnimated = false;

  return NS_OK;
}

nsresult
RasterImage::CopyFrame(uint32_t aWhichFrame,
                       uint32_t aFlags,
                       gfxImageSurface **_retval)
{
  if (aWhichFrame > FRAME_MAX_VALUE)
    return NS_ERROR_INVALID_ARG;

  if (mError)
    return NS_ERROR_FAILURE;

  // Disallowed in the API
  if (mInDecoder && (aFlags & imgIContainer::FLAG_SYNC_DECODE))
    return NS_ERROR_FAILURE;

  nsresult rv;

  if (!ApplyDecodeFlags(aFlags))
    return NS_ERROR_NOT_AVAILABLE;

  // If requested, synchronously flush any data we have lying around to the decoder
  if (aFlags & FLAG_SYNC_DECODE) {
    rv = SyncDecode();
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  NS_ENSURE_ARG_POINTER(_retval);

  // Get the frame. If it's not there, it's probably the caller's fault for
  // not waiting for the data to be loaded from the network or not passing
  // FLAG_SYNC_DECODE
  uint32_t frameIndex = (aWhichFrame == FRAME_FIRST) ?
                        0 : GetCurrentImgFrameIndex();
  imgFrame *frame = GetDrawableImgFrame(frameIndex);
  if (!frame) {
    *_retval = nullptr;
    return NS_ERROR_FAILURE;
  }

  nsRefPtr<gfxPattern> pattern;
  frame->GetPattern(getter_AddRefs(pattern));
  nsIntRect intframerect = frame->GetRect();
  gfxRect framerect(intframerect.x, intframerect.y, intframerect.width, intframerect.height);

  // Create a 32-bit image surface of our size, but draw using the frame's
  // rect, implicitly padding the frame out to the image's size.
  nsRefPtr<gfxImageSurface> imgsurface = new gfxImageSurface(gfxIntSize(mSize.width, mSize.height),
                                                             gfxASurface::ImageFormatARGB32);
  gfxContext ctx(imgsurface);
  ctx.SetOperator(gfxContext::OPERATOR_SOURCE);
  ctx.Rectangle(framerect);
  ctx.Translate(framerect.TopLeft());
  ctx.SetPattern(pattern);
  ctx.Fill();

  *_retval = imgsurface.forget().get();
  return NS_OK;
}

//******************************************************************************
/* [noscript] gfxASurface getFrame(in uint32_t aWhichFrame,
 *                                 in uint32_t aFlags); */
NS_IMETHODIMP
RasterImage::GetFrame(uint32_t aWhichFrame,
                      uint32_t aFlags,
                      gfxASurface **_retval)
{
  if (aWhichFrame > FRAME_MAX_VALUE)
    return NS_ERROR_INVALID_ARG;

  if (mError)
    return NS_ERROR_FAILURE;

  // Disallowed in the API
  if (mInDecoder && (aFlags & imgIContainer::FLAG_SYNC_DECODE))
    return NS_ERROR_FAILURE;

  nsresult rv = NS_OK;

  if (!ApplyDecodeFlags(aFlags))
    return NS_ERROR_NOT_AVAILABLE;

  // If the caller requested a synchronous decode, do it
  if (aFlags & FLAG_SYNC_DECODE) {
    rv = SyncDecode();
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  // Get the frame. If it's not there, it's probably the caller's fault for
  // not waiting for the data to be loaded from the network or not passing
  // FLAG_SYNC_DECODE
  uint32_t frameIndex = (aWhichFrame == FRAME_FIRST) ?
                          0 : GetCurrentImgFrameIndex();
  imgFrame *frame = GetDrawableImgFrame(frameIndex);
  if (!frame) {
    *_retval = nullptr;
    return NS_ERROR_FAILURE;
  }

  nsRefPtr<gfxASurface> framesurf;

  // If this frame covers the entire image, we can just reuse its existing
  // surface.
  nsIntRect framerect = frame->GetRect();
  if (framerect.x == 0 && framerect.y == 0 &&
      framerect.width == mSize.width &&
      framerect.height == mSize.height)
    rv = frame->GetSurface(getter_AddRefs(framesurf));

  // The image doesn't have a surface because it's been optimized away. Create
  // one.
  if (!framesurf) {
    nsRefPtr<gfxImageSurface> imgsurf;
    rv = CopyFrame(aWhichFrame, aFlags, getter_AddRefs(imgsurf));
    framesurf = imgsurf;
  }

  *_retval = framesurf.forget().get();

  return rv;
}

already_AddRefed<layers::Image>
RasterImage::GetCurrentImage()
{
  if (!mDecoded) {
    // We can't call StartDecoding because that can synchronously notify
    // which can cause DOM modification
    RequestDecode();
    return nullptr;
  }

  nsRefPtr<gfxASurface> imageSurface;
  nsresult rv = GetFrame(FRAME_CURRENT, FLAG_NONE, getter_AddRefs(imageSurface));
  NS_ENSURE_SUCCESS(rv, nullptr);

  if (!imageSurface) {
    return nullptr;
  }

  if (!mImageContainer) {
    mImageContainer = LayerManager::CreateImageContainer();
  }

  CairoImage::Data cairoData;
  cairoData.mSurface = imageSurface;
  GetWidth(&cairoData.mSize.width);
  GetHeight(&cairoData.mSize.height);

  ImageFormat cairoFormat = CAIRO_SURFACE;
  nsRefPtr<layers::Image> image = mImageContainer->CreateImage(&cairoFormat, 1);
  NS_ASSERTION(image, "Failed to create Image");

  NS_ASSERTION(image->GetFormat() == cairoFormat, "Wrong format");
  static_cast<CairoImage*>(image.get())->SetData(cairoData);

  return image.forget();
}


NS_IMETHODIMP
RasterImage::GetImageContainer(LayerManager* aManager, ImageContainer **_retval)
{
  int32_t maxTextureSize = aManager->GetMaxTextureSize();
  if (mSize.width > maxTextureSize || mSize.height > maxTextureSize) {
    *_retval = nullptr;
    return NS_OK;
  }

  if (mImageContainer) {
    *_retval = mImageContainer;
    NS_ADDREF(*_retval);
    return NS_OK;
  }

  nsRefPtr<layers::Image> image = GetCurrentImage();
  if (!image) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  mImageContainer->SetCurrentImageInTransaction(image);

  *_retval = mImageContainer;
  NS_ADDREF(*_retval);
  return NS_OK;
}

void
RasterImage::UpdateImageContainer()
{
  if (!mImageContainer || IsInUpdateImageContainer()) {
    return;
  }

  SetInUpdateImageContainer(true);

  nsRefPtr<layers::Image> image = GetCurrentImage();
  if (!image) {
    return;
  }
  mImageContainer->SetCurrentImage(image);
  SetInUpdateImageContainer(false);
}

size_t
RasterImage::HeapSizeOfSourceWithComputedFallback(nsMallocSizeOfFun aMallocSizeOf) const
{
  // n == 0 is possible for two reasons.
  // - This is a zero-length image.
  // - We're on a platform where moz_malloc_size_of always returns 0.
  // In either case the fallback works appropriately.
  size_t n = mSourceData.SizeOfExcludingThis(aMallocSizeOf);
  if (n == 0) {
    n = mSourceData.Length();
  }
  return n;
}

size_t
RasterImage::SizeOfDecodedWithComputedFallbackIfHeap(gfxASurface::MemoryLocation aLocation,
                                                     nsMallocSizeOfFun aMallocSizeOf) const
{
  size_t n = 0;
  for (uint32_t i = 0; i < mFrames.Length(); ++i) {
    imgFrame* frame = mFrames.SafeElementAt(i, nullptr);
    NS_ABORT_IF_FALSE(frame, "Null frame in frame array!");
    n += frame->SizeOfExcludingThisWithComputedFallbackIfHeap(aLocation, aMallocSizeOf);
  }

  if (mScaleResult.status == SCALE_DONE) {
    n += mScaleResult.frame->SizeOfExcludingThisWithComputedFallbackIfHeap(aLocation, aMallocSizeOf);
  }

  return n;
}

size_t
RasterImage::HeapSizeOfDecodedWithComputedFallback(nsMallocSizeOfFun aMallocSizeOf) const
{
  return SizeOfDecodedWithComputedFallbackIfHeap(gfxASurface::MEMORY_IN_PROCESS_HEAP,
                                                 aMallocSizeOf);
}

size_t
RasterImage::NonHeapSizeOfDecoded() const
{
  return SizeOfDecodedWithComputedFallbackIfHeap(gfxASurface::MEMORY_IN_PROCESS_NONHEAP,
                                                 NULL);
}

size_t
RasterImage::OutOfProcessSizeOfDecoded() const
{
  return SizeOfDecodedWithComputedFallbackIfHeap(gfxASurface::MEMORY_OUT_OF_PROCESS,
                                                 NULL);
}

void
RasterImage::DeleteImgFrame(uint32_t framenum)
{
  NS_ABORT_IF_FALSE(framenum < mFrames.Length(), "Deleting invalid frame!");

  delete mFrames[framenum];
  mFrames[framenum] = nullptr;
}

nsresult
RasterImage::InternalAddFrameHelper(uint32_t framenum, imgFrame *aFrame,
                                    uint8_t **imageData, uint32_t *imageLength,
                                    uint32_t **paletteData, uint32_t *paletteLength,
                                    imgFrame** aRetFrame)
{
  NS_ABORT_IF_FALSE(framenum <= mFrames.Length(), "Invalid frame index!");
  if (framenum > mFrames.Length())
    return NS_ERROR_INVALID_ARG;

  nsAutoPtr<imgFrame> frame(aFrame);

  // We are in the middle of decoding. This will be unlocked when we finish
  // decoding or switch to another frame.
  frame->LockImageData();

  if (paletteData && paletteLength)
    frame->GetPaletteData(paletteData, paletteLength);

  frame->GetImageData(imageData, imageLength);

  *aRetFrame = frame;

  mFrames.InsertElementAt(framenum, frame.forget());

  return NS_OK;
}

nsresult
RasterImage::InternalAddFrame(uint32_t framenum,
                              int32_t aX, int32_t aY,
                              int32_t aWidth, int32_t aHeight,
                              gfxASurface::gfxImageFormat aFormat,
                              uint8_t aPaletteDepth,
                              uint8_t **imageData,
                              uint32_t *imageLength,
                              uint32_t **paletteData,
                              uint32_t *paletteLength,
                              imgFrame** aRetFrame)
{
  // We assume that we're in the middle of decoding because we unlock the
  // previous frame when we create a new frame, and only when decoding do we
  // lock frames.
  NS_ABORT_IF_FALSE(mDecoder, "Only decoders may add frames!");

  NS_ABORT_IF_FALSE(framenum <= mFrames.Length(), "Invalid frame index!");
  if (framenum > mFrames.Length())
    return NS_ERROR_INVALID_ARG;

  nsAutoPtr<imgFrame> frame(new imgFrame());

  nsresult rv = frame->Init(aX, aY, aWidth, aHeight, aFormat, aPaletteDepth);
  NS_ENSURE_SUCCESS(rv, rv);

  // We know we are in a decoder. Therefore, we must unlock the previous frame
  // when we move on to decoding into the next frame.
  if (mFrames.Length() > 0) {
    imgFrame *prevframe = mFrames.ElementAt(mFrames.Length() - 1);
    prevframe->UnlockImageData();
  }

  if (mFrames.Length() == 0) {
    return InternalAddFrameHelper(framenum, frame.forget(), imageData, imageLength,
                                  paletteData, paletteLength, aRetFrame);
  }

  if (mFrames.Length() == 1) {
    // Since we're about to add our second frame, initialize animation stuff
    EnsureAnimExists();

    // If we dispose of the first frame by clearing it, then the
    // First Frame's refresh area is all of itself.
    // RESTORE_PREVIOUS is invalid (assumed to be DISPOSE_CLEAR)
    int32_t frameDisposalMethod = mFrames[0]->GetFrameDisposalMethod();
    if (frameDisposalMethod == kDisposeClear ||
        frameDisposalMethod == kDisposeRestorePrevious)
      mAnim->firstFrameRefreshArea = mFrames[0]->GetRect();
  }

  // Calculate firstFrameRefreshArea
  // Some gifs are huge but only have a small area that they animate
  // We only need to refresh that small area when Frame 0 comes around again
  nsIntRect frameRect = frame->GetRect();
  mAnim->firstFrameRefreshArea.UnionRect(mAnim->firstFrameRefreshArea,
                                         frameRect);

  rv = InternalAddFrameHelper(framenum, frame.forget(), imageData, imageLength,
                              paletteData, paletteLength, aRetFrame);

  // We may be able to start animating, if we now have enough frames
  EvaluateAnimation();

  return rv;
}

bool
RasterImage::ApplyDecodeFlags(uint32_t aNewFlags)
{
  if (mFrameDecodeFlags == (aNewFlags & DECODE_FLAGS_MASK))
    return true; // Not asking very much of us here.

  if (mDecoded) {
    // if we can't discard, then we're screwed; we have no way
    // to re-decode.  Similarly if we aren't allowed to do a sync
    // decode.
    if (!(aNewFlags & FLAG_SYNC_DECODE))
      return false;
    if (!CanForciblyDiscard() || mDecoder || mAnim)
      return false;
    ForceDiscard();
  }

  mFrameDecodeFlags = aNewFlags & DECODE_FLAGS_MASK;
  return true;
}

nsresult
RasterImage::SetSize(int32_t aWidth, int32_t aHeight)
{
  MOZ_ASSERT(NS_IsMainThread());

  if (mError)
    return NS_ERROR_FAILURE;

  // Ensure that we have positive values
  // XXX - Why isn't the size unsigned? Should this be changed?
  if ((aWidth < 0) || (aHeight < 0))
    return NS_ERROR_INVALID_ARG;

  // if we already have a size, check the new size against the old one
  if (!mMultipart && mHasSize &&
      ((aWidth != mSize.width) || (aHeight != mSize.height))) {
    NS_WARNING("Image changed size on redecode! This should not happen!");

    // Make the decoder aware of the error so that it doesn't try to call
    // FinishInternal during ShutdownDecoder.
    if (mDecoder)
      mDecoder->PostResizeError();

    DoError();
    return NS_ERROR_UNEXPECTED;
  }

  // Set the size and flag that we have it
  mSize.SizeTo(aWidth, aHeight);
  mHasSize = true;

  return NS_OK;
}

nsresult
RasterImage::EnsureFrame(uint32_t aFrameNum, int32_t aX, int32_t aY,
                         int32_t aWidth, int32_t aHeight,
                         gfxASurface::gfxImageFormat aFormat,
                         uint8_t aPaletteDepth,
                         uint8_t **imageData, uint32_t *imageLength,
                         uint32_t **paletteData, uint32_t *paletteLength,
                         imgFrame** aRetFrame)
{
  if (mError)
    return NS_ERROR_FAILURE;

  NS_ENSURE_ARG_POINTER(imageData);
  NS_ENSURE_ARG_POINTER(imageLength);
  NS_ENSURE_ARG_POINTER(aRetFrame);
  NS_ABORT_IF_FALSE(aFrameNum <= mFrames.Length(), "Invalid frame index!");

  if (aPaletteDepth > 0) {
    NS_ENSURE_ARG_POINTER(paletteData);
    NS_ENSURE_ARG_POINTER(paletteLength);
  }

  if (aFrameNum > mFrames.Length())
    return NS_ERROR_INVALID_ARG;

  // Adding a frame that doesn't already exist.
  if (aFrameNum == mFrames.Length())
    return InternalAddFrame(aFrameNum, aX, aY, aWidth, aHeight, aFormat,
                            aPaletteDepth, imageData, imageLength,
                            paletteData, paletteLength, aRetFrame);

  imgFrame *frame = GetImgFrameNoDecode(aFrameNum);
  if (!frame)
    return InternalAddFrame(aFrameNum, aX, aY, aWidth, aHeight, aFormat,
                            aPaletteDepth, imageData, imageLength,
                            paletteData, paletteLength, aRetFrame);

  // See if we can re-use the frame that already exists.
  nsIntRect rect = frame->GetRect();
  if (rect.x == aX && rect.y == aY && rect.width == aWidth &&
      rect.height == aHeight && frame->GetFormat() == aFormat &&
      frame->GetPaletteDepth() == aPaletteDepth) {
    frame->GetImageData(imageData, imageLength);
    if (paletteData) {
      frame->GetPaletteData(paletteData, paletteLength);
    }

    *aRetFrame = frame;

    // We can re-use the frame if it has image data.
    if (*imageData && paletteData && *paletteData) {
      return NS_OK;
    }
    if (*imageData && !paletteData) {
      return NS_OK;
    }
  }

  // Not reusable, so replace the frame directly.

  // We know this frame is already locked, because it's the one we're currently
  // writing to.
  frame->UnlockImageData();

  DeleteImgFrame(aFrameNum);
  mFrames.RemoveElementAt(aFrameNum);
  nsAutoPtr<imgFrame> newFrame(new imgFrame());
  nsresult rv = newFrame->Init(aX, aY, aWidth, aHeight, aFormat, aPaletteDepth);
  NS_ENSURE_SUCCESS(rv, rv);
  return InternalAddFrameHelper(aFrameNum, newFrame.forget(), imageData,
                                imageLength, paletteData, paletteLength,
                                aRetFrame);
}

nsresult
RasterImage::EnsureFrame(uint32_t aFramenum, int32_t aX, int32_t aY,
                         int32_t aWidth, int32_t aHeight,
                         gfxASurface::gfxImageFormat aFormat,
                         uint8_t** imageData, uint32_t* imageLength,
                         imgFrame** aFrame)
{
  return EnsureFrame(aFramenum, aX, aY, aWidth, aHeight, aFormat,
                     /* aPaletteDepth = */ 0, imageData, imageLength,
                     /* aPaletteData = */ nullptr,
                     /* aPaletteLength = */ nullptr,
                     aFrame);
}

nsresult
RasterImage::SetFrameAsNonPremult(uint32_t aFrameNum, bool aIsNonPremult)
{
  if (mError)
    return NS_ERROR_FAILURE;

  NS_ABORT_IF_FALSE(aFrameNum < mFrames.Length(), "Invalid frame index!");
  if (aFrameNum >= mFrames.Length())
    return NS_ERROR_INVALID_ARG;

  imgFrame* frame = GetImgFrameNoDecode(aFrameNum);
  NS_ABORT_IF_FALSE(frame, "Calling SetFrameAsNonPremult on frame that doesn't exist!");
  NS_ENSURE_TRUE(frame, NS_ERROR_FAILURE);

  frame->SetAsNonPremult(aIsNonPremult);

  return NS_OK;
}

nsresult
RasterImage::DecodingComplete()
{
  MOZ_ASSERT(NS_IsMainThread());

  if (mError)
    return NS_ERROR_FAILURE;

  // Flag that we're done decoding.
  // XXX - these should probably be combined when we fix animated image
  // discarding with bug 500402.
  mDecoded = true;
  mHasBeenDecoded = true;

  nsresult rv;

  // We now have one of the qualifications for discarding. Re-evaluate.
  if (CanDiscard()) {
    NS_ABORT_IF_FALSE(!DiscardingActive(),
                      "We shouldn't have been discardable before this");
    rv = DiscardTracker::Reset(&mDiscardTrackerNode);
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  // If there's only 1 frame, optimize it. Optimizing animated images
  // is not supported.
  //
  // We don't optimize the frame for multipart images because we reuse
  // the frame.
  if ((mFrames.Length() == 1) && !mMultipart) {
    rv = mFrames[0]->Optimize();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Double-buffer our frame in the multipart case, since we'll start decoding
  // into mFrames again immediately and this produces severe tearing.
  if (mMultipart) {
    if (mFrames.Length() == 1) {
      imgFrame* swapFrame = mMultipartDecodedFrame;
      mMultipartDecodedFrame = GetImgFrameNoDecode(GetCurrentFrameIndex());
      mFrames.Clear();
      if (swapFrame) {
        mFrames.AppendElement(swapFrame);
      }
    } else {
      // Don't double buffer for animated multipart images. It entails more
      // complexity and it's not really needed since we already are smart about
      // not displaying the still-decoding frame of an animated image. We may
      // have already stored an extra frame, though, so we'll release it here.
      delete mMultipartDecodedFrame;
    }
  }

  return NS_OK;
}

//******************************************************************************
/* void StartAnimation () */
nsresult
RasterImage::StartAnimation()
{
  if (mError)
    return NS_ERROR_FAILURE;

  NS_ABORT_IF_FALSE(ShouldAnimate(), "Should not animate!");

  EnsureAnimExists();

  imgFrame* currentFrame = GetCurrentImgFrame();
  if (currentFrame) {
    if (currentFrame->GetTimeout() < 0) { // -1 means display this frame forever
      mAnimationFinished = true;
      return NS_ERROR_ABORT;
    }

    // We need to set the time that this initial frame was first displayed, as
    // this is used in AdvanceFrame().
    mAnim->currentAnimationFrameTime = TimeStamp::Now();
  }

  return NS_OK;
}

//******************************************************************************
/* void stopAnimation (); */
nsresult
RasterImage::StopAnimation()
{
  NS_ABORT_IF_FALSE(mAnimating, "Should be animating!");

  if (mError)
    return NS_ERROR_FAILURE;

  return NS_OK;
}

//******************************************************************************
/* void resetAnimation (); */
NS_IMETHODIMP
RasterImage::ResetAnimation()
{
  if (mError)
    return NS_ERROR_FAILURE;

  if (mAnimationMode == kDontAnimMode ||
      !mAnim || mAnim->currentAnimationFrameIndex == 0)
    return NS_OK;

  mAnimationFinished = false;

  if (mAnimating)
    StopAnimation();

  mAnim->lastCompositedFrameIndex = -1;
  mAnim->currentAnimationFrameIndex = 0;
  UpdateImageContainer();

  // Note - We probably want to kick off a redecode somewhere around here when
  // we fix bug 500402.

  // Update display if we were animating before
  if (mAnimating && mStatusTracker) {
    mStatusTracker->FrameChanged(&(mAnim->firstFrameRefreshArea));
  }

  if (ShouldAnimate()) {
    StartAnimation();
    // The animation may not have been running before, if mAnimationFinished
    // was false (before we changed it to true in this function). So, mark the
    // animation as running.
    mAnimating = true;
  }

  return NS_OK;
}

void
RasterImage::SetLoopCount(int32_t aLoopCount)
{
  if (mError)
    return;

  // -1  infinite
  //  0  no looping, one iteration
  //  1  one loop, two iterations
  //  ...
  mLoopCount = aLoopCount;
}

nsresult
RasterImage::AddSourceData(const char *aBuffer, uint32_t aCount)
{
  MutexAutoLock lock(mDecodingMutex);

  if (mError)
    return NS_ERROR_FAILURE;

  NS_ENSURE_ARG_POINTER(aBuffer);
  nsresult rv = NS_OK;

  // We should not call this if we're not initialized
  NS_ABORT_IF_FALSE(mInitialized, "Calling AddSourceData() on uninitialized "
                                  "RasterImage!");

  // We should not call this if we're already finished adding source data
  NS_ABORT_IF_FALSE(!mHasSourceData, "Calling AddSourceData() after calling "
                                     "sourceDataComplete()!");

  // This call should come straight from necko - no reentrancy allowed
  NS_ABORT_IF_FALSE(!mInDecoder, "Re-entrant call to AddSourceData!");

  // Image is already decoded, we shouldn't be getting data, but it could
  // be extra garbage data at the end of a file.
  if (mDecoded) {
    return NS_OK;
  }

  // Starting a new part's frames, let's clean up before we add any
  // This needs to happen just before we start getting EnsureFrame() call(s),
  // so that there's no gap for anything to miss us.
  if (mMultipart && mBytesDecoded == 0) {
    // Our previous state may have been animated, so let's clean up
    if (mAnimating) {
      StopAnimation();
      mAnimating = false;
    }
    mAnimationFinished = false;
    if (mAnim) {
      delete mAnim;
      mAnim = nullptr;
    }
    // If there's only one frame, this could cause flickering
    int old_frame_count = mFrames.Length();
    if (old_frame_count > 1) {
      for (int i = 0; i < old_frame_count; ++i) {
        DeleteImgFrame(i);
      }
      mFrames.Clear();
    }
  }

  // If we're not storing source data and we've previously gotten the size,
  // write the data directly to the decoder. (If we haven't gotten the size,
  // we'll queue up the data and write it out when we do.)
  if (!StoringSourceData() && mHasSize) {
    mDecoder->SetSynchronous(true);
    rv = WriteToDecoder(aBuffer, aCount);
    mDecoder->SetSynchronous(false);
    CONTAINER_ENSURE_SUCCESS(rv);

    // We're not storing source data, so this data is probably coming straight
    // from the network. In this case, we want to display data as soon as we
    // get it, so we want to flush invalidations after every write.
    nsRefPtr<Decoder> kungFuDeathGrip = mDecoder;
    mInDecoder = true;
    mDecoder->FlushInvalidations();
    mInDecoder = false;

    rv = FinishedSomeDecoding();
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  // Otherwise, we're storing data in the source buffer
  else {

    // Store the data
    char *newElem = mSourceData.AppendElements(aBuffer, aCount);
    if (!newElem)
      return NS_ERROR_OUT_OF_MEMORY;

    if (mDecoder) {
      DecodePool::Singleton()->RequestDecode(this);
    }
  }

  // Statistics
  total_source_bytes += aCount;
  if (mDiscardable)
    discardable_source_bytes += aCount;
  PR_LOG (GetCompressedImageAccountingLog(), PR_LOG_DEBUG,
          ("CompressedImageAccounting: Added compressed data to RasterImage %p (%s). "
           "Total Containers: %d, Discardable containers: %d, "
           "Total source bytes: %lld, Source bytes for discardable containers %lld",
           this,
           mSourceDataMimeType.get(),
           num_containers,
           num_discardable_containers,
           total_source_bytes,
           discardable_source_bytes));

  return NS_OK;
}

/* Note!  buf must be declared as char buf[9]; */
// just used for logging and hashing the header
static void
get_header_str (char *buf, char *data, size_t data_len)
{
  int i;
  int n;
  static char hex[] = "0123456789abcdef";

  n = data_len < 4 ? data_len : 4;

  for (i = 0; i < n; i++) {
    buf[i * 2]     = hex[(data[i] >> 4) & 0x0f];
    buf[i * 2 + 1] = hex[data[i] & 0x0f];
  }

  buf[i * 2] = 0;
}

nsresult
RasterImage::DoImageDataComplete()
{
  MOZ_ASSERT(NS_IsMainThread());

  if (mError)
    return NS_ERROR_FAILURE;

  // If we've been called before, ignore. Otherwise, flag that we have everything
  if (mHasSourceData)
    return NS_OK;
  mHasSourceData = true;

  // If there's a decoder open, synchronously decode the beginning of the image
  // to check for errors and get the image's size.  (If we already have the
  // image's size, this does nothing.)  Then kick off an async decode of the
  // rest of the image.
  if (mDecoder) {
    nsresult rv = DecodePool::Singleton()->DecodeUntilSizeAvailable(this);
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  {
    MutexAutoLock lock(mDecodingMutex);

    // If we're not storing any source data, then there's nothing more we can do
    // once we've tried decoding for size.
    if (!StoringSourceData() && mDecoder) {
      nsresult rv = ShutdownDecoder(eShutdownIntent_Done);
      CONTAINER_ENSURE_SUCCESS(rv);
    }

    // If DecodeUntilSizeAvailable didn't finish the decode, let the decode worker
    // finish decoding this image.
    if (mDecoder) {
      DecodePool::Singleton()->RequestDecode(this);
    }

    // Free up any extra space in the backing buffer
    mSourceData.Compact();
  }

  // Log header information
  if (PR_LOG_TEST(GetCompressedImageAccountingLog(), PR_LOG_DEBUG)) {
    char buf[9];
    get_header_str(buf, mSourceData.Elements(), mSourceData.Length());
    PR_LOG (GetCompressedImageAccountingLog(), PR_LOG_DEBUG,
            ("CompressedImageAccounting: RasterImage::SourceDataComplete() - data "
             "is done for container %p (%s) - header %p is 0x%s (length %d)",
             this,
             mSourceDataMimeType.get(),
             mSourceData.Elements(),
             buf,
             mSourceData.Length()));
  }

  // We now have one of the qualifications for discarding. Re-evaluate.
  if (CanDiscard()) {
    nsresult rv = DiscardTracker::Reset(&mDiscardTrackerNode);
    CONTAINER_ENSURE_SUCCESS(rv);
  }
  return NS_OK;
}

nsresult
RasterImage::OnImageDataComplete(nsIRequest*, nsISupports*, nsresult aStatus, bool aLastPart)
{
  nsresult finalStatus = DoImageDataComplete();

  // Give precedence to Necko failure codes.
  if (NS_FAILED(aStatus))
    finalStatus = aStatus;

  if (mDecodeRequest) {
    mDecodeRequest->mStatusTracker->GetDecoderObserver()->OnStopRequest(aLastPart, finalStatus);
  } else {
    mStatusTracker->GetDecoderObserver()->OnStopRequest(aLastPart, finalStatus);
  }

  // We just recorded OnStopRequest; we need to inform our listeners.
  {
    MutexAutoLock lock(mDecodingMutex);
    FinishedSomeDecoding();
  }

  return finalStatus;
}

nsresult
RasterImage::OnImageDataAvailable(nsIRequest*,
                                  nsISupports*,
                                  nsIInputStream* aInStr,
                                  uint64_t,
                                  uint32_t aCount)
{
  nsresult rv;

  // WriteToRasterImage always consumes everything it gets
  // if it doesn't run out of memory
  uint32_t bytesRead;
  rv = aInStr->ReadSegments(WriteToRasterImage, this, aCount, &bytesRead);

  NS_ABORT_IF_FALSE(bytesRead == aCount || HasError(),
    "WriteToRasterImage should consume everything or the image must be in error!");

  return rv;
}

nsresult
RasterImage::OnNewSourceData()
{
  MOZ_ASSERT(NS_IsMainThread());

  nsresult rv;

  if (mError)
    return NS_ERROR_FAILURE;

  // The source data should be complete before calling this
  NS_ABORT_IF_FALSE(mHasSourceData,
                    "Calling NewSourceData before SourceDataComplete!");
  if (!mHasSourceData)
    return NS_ERROR_ILLEGAL_VALUE;

  // Only supported for multipart channels. It wouldn't be too hard to change this,
  // but it would involve making sure that things worked for decode-on-draw and
  // discarding. Presently there's no need for this, so we don't.
  NS_ABORT_IF_FALSE(mMultipart, "NewSourceData only supported for multipart");
  if (!mMultipart)
    return NS_ERROR_ILLEGAL_VALUE;

  // We're multipart, so we shouldn't be storing source data
  NS_ABORT_IF_FALSE(!StoringSourceData(),
                    "Shouldn't be storing source data for multipart");

  // We're not storing the source data and we got SourceDataComplete. We should
  // have shut down the previous decoder
  NS_ABORT_IF_FALSE(!mDecoder, "Shouldn't have a decoder in NewSourceData");

  // The decoder was shut down and we didn't flag an error, so we should be decoded
  NS_ABORT_IF_FALSE(mDecoded, "Should be decoded in NewSourceData");

  // Reset some flags
  mDecoded = false;
  mHasSourceData = false;
  mHasSize = false;
  mWantFullDecode = true;
  mDecodeRequest = nullptr;

  // We always need the size first.
  rv = InitDecoder(/* aDoSizeDecode = */ true);
  CONTAINER_ENSURE_SUCCESS(rv);

  return NS_OK;
}

nsresult
RasterImage::SetSourceSizeHint(uint32_t sizeHint)
{
  if (sizeHint && StoringSourceData())
    return mSourceData.SetCapacity(sizeHint) ? NS_OK : NS_ERROR_OUT_OF_MEMORY;
  return NS_OK;
}

//******************************************************************************
// DoComposite gets called when the timer for animation get fired and we have to
// update the composited frame of the animation.
nsresult
RasterImage::DoComposite(nsIntRect* aDirtyRect,
                         imgFrame* aPrevFrame,
                         imgFrame* aNextFrame,
                         int32_t aNextFrameIndex)
{
  NS_ENSURE_ARG_POINTER(aDirtyRect);
  NS_ENSURE_ARG_POINTER(aPrevFrame);
  NS_ENSURE_ARG_POINTER(aNextFrame);

  int32_t prevFrameDisposalMethod = aPrevFrame->GetFrameDisposalMethod();
  if (prevFrameDisposalMethod == kDisposeRestorePrevious &&
      !mAnim->compositingPrevFrame)
    prevFrameDisposalMethod = kDisposeClear;

  nsIntRect prevFrameRect = aPrevFrame->GetRect();
  bool isFullPrevFrame = (prevFrameRect.x == 0 && prevFrameRect.y == 0 &&
                          prevFrameRect.width == mSize.width &&
                          prevFrameRect.height == mSize.height);

  // Optimization: DisposeClearAll if the previous frame is the same size as
  //               container and it's clearing itself
  if (isFullPrevFrame &&
      (prevFrameDisposalMethod == kDisposeClear))
    prevFrameDisposalMethod = kDisposeClearAll;

  int32_t nextFrameDisposalMethod = aNextFrame->GetFrameDisposalMethod();
  nsIntRect nextFrameRect = aNextFrame->GetRect();
  bool isFullNextFrame = (nextFrameRect.x == 0 && nextFrameRect.y == 0 &&
                          nextFrameRect.width == mSize.width &&
                          nextFrameRect.height == mSize.height);

  if (!aNextFrame->GetIsPaletted()) {
    // Optimization: Skip compositing if the previous frame wants to clear the
    //               whole image
    if (prevFrameDisposalMethod == kDisposeClearAll) {
      aDirtyRect->SetRect(0, 0, mSize.width, mSize.height);
      return NS_OK;
    }

    // Optimization: Skip compositing if this frame is the same size as the
    //               container and it's fully drawing over prev frame (no alpha)
    if (isFullNextFrame &&
        (nextFrameDisposalMethod != kDisposeRestorePrevious) &&
        !aNextFrame->GetHasAlpha()) {
      aDirtyRect->SetRect(0, 0, mSize.width, mSize.height);
      return NS_OK;
    }
  }

  // Calculate area that needs updating
  switch (prevFrameDisposalMethod) {
    default:
    case kDisposeNotSpecified:
    case kDisposeKeep:
      *aDirtyRect = nextFrameRect;
      break;

    case kDisposeClearAll:
      // Whole image container is cleared
      aDirtyRect->SetRect(0, 0, mSize.width, mSize.height);
      break;

    case kDisposeClear:
      // Calc area that needs to be redrawn (the combination of previous and
      // this frame)
      // XXX - This could be done with multiple framechanged calls
      //       Having prevFrame way at the top of the image, and nextFrame
      //       way at the bottom, and both frames being small, we'd be
      //       telling framechanged to refresh the whole image when only two
      //       small areas are needed.
      aDirtyRect->UnionRect(nextFrameRect, prevFrameRect);
      break;

    case kDisposeRestorePrevious:
      aDirtyRect->SetRect(0, 0, mSize.width, mSize.height);
      break;
  }

  // Optimization:
  //   Skip compositing if the last composited frame is this frame
  //   (Only one composited frame was made for this animation.  Example:
  //    Only Frame 3 of a 10 frame image required us to build a composite frame
  //    On the second loop, we do not need to rebuild the frame
  //    since it's still sitting in compositingFrame)
  if (mAnim->lastCompositedFrameIndex == aNextFrameIndex) {
    return NS_OK;
  }

  bool needToBlankComposite = false;

  // Create the Compositing Frame
  if (!mAnim->compositingFrame) {
    mAnim->compositingFrame = new imgFrame();
    nsresult rv = mAnim->compositingFrame->Init(0, 0, mSize.width, mSize.height,
                                                gfxASurface::ImageFormatARGB32);
    if (NS_FAILED(rv)) {
      mAnim->compositingFrame = nullptr;
      return rv;
    }
    needToBlankComposite = true;
  } else if (aNextFrameIndex != mAnim->lastCompositedFrameIndex+1) {

    // If we are not drawing on top of last composited frame,
    // then we are building a new composite frame, so let's clear it first.
    needToBlankComposite = true;
  }

  // More optimizations possible when next frame is not transparent
  // But if the next frame has kDisposeRestorePrevious,
  // this "no disposal" optimization is not possible,
  // because the frame in "after disposal operation" state
  // needs to be stored in compositingFrame, so it can be
  // copied into compositingPrevFrame later.
  bool doDisposal = true;
  if (!aNextFrame->GetHasAlpha() &&
      nextFrameDisposalMethod != kDisposeRestorePrevious) {
    if (isFullNextFrame) {
      // Optimization: No need to dispose prev.frame when
      // next frame is full frame and not transparent.
      doDisposal = false;
      // No need to blank the composite frame
      needToBlankComposite = false;
    } else {
      if ((prevFrameRect.x >= nextFrameRect.x) &&
          (prevFrameRect.y >= nextFrameRect.y) &&
          (prevFrameRect.x + prevFrameRect.width <= nextFrameRect.x + nextFrameRect.width) &&
          (prevFrameRect.y + prevFrameRect.height <= nextFrameRect.y + nextFrameRect.height)) {
        // Optimization: No need to dispose prev.frame when
        // next frame fully overlaps previous frame.
        doDisposal = false;
      }
    }
  }

  if (doDisposal) {
    // Dispose of previous: clear, restore, or keep (copy)
    switch (prevFrameDisposalMethod) {
      case kDisposeClear:
        if (needToBlankComposite) {
          // If we just created the composite, it could have anything in it's
          // buffer. Clear whole frame
          ClearFrame(mAnim->compositingFrame);
        } else {
          // Only blank out previous frame area (both color & Mask/Alpha)
          ClearFrame(mAnim->compositingFrame, prevFrameRect);
        }
        break;

      case kDisposeClearAll:
        ClearFrame(mAnim->compositingFrame);
        break;

      case kDisposeRestorePrevious:
        // It would be better to copy only the area changed back to
        // compositingFrame.
        if (mAnim->compositingPrevFrame) {
          CopyFrameImage(mAnim->compositingPrevFrame, mAnim->compositingFrame);

          // destroy only if we don't need it for this frame's disposal
          if (nextFrameDisposalMethod != kDisposeRestorePrevious)
            mAnim->compositingPrevFrame = nullptr;
        } else {
          ClearFrame(mAnim->compositingFrame);
        }
        break;

      default:
        // Copy previous frame into compositingFrame before we put the new frame on top
        // Assumes that the previous frame represents a full frame (it could be
        // smaller in size than the container, as long as the frame before it erased
        // itself)
        // Note: Frame 1 never gets into DoComposite(), so (aNextFrameIndex - 1) will
        // always be a valid frame number.
        if (mAnim->lastCompositedFrameIndex != aNextFrameIndex - 1) {
          if (isFullPrevFrame && !aPrevFrame->GetIsPaletted()) {
            // Just copy the bits
            CopyFrameImage(aPrevFrame, mAnim->compositingFrame);
          } else {
            if (needToBlankComposite) {
              // Only blank composite when prev is transparent or not full.
              if (aPrevFrame->GetHasAlpha() || !isFullPrevFrame) {
                ClearFrame(mAnim->compositingFrame);
              }
            }
            DrawFrameTo(aPrevFrame, mAnim->compositingFrame, prevFrameRect);
          }
        }
    }
  } else if (needToBlankComposite) {
    // If we just created the composite, it could have anything in it's
    // buffers. Clear them
    ClearFrame(mAnim->compositingFrame);
  }

  // Check if the frame we are composing wants the previous image restored afer
  // it is done. Don't store it (again) if last frame wanted its image restored
  // too
  if ((nextFrameDisposalMethod == kDisposeRestorePrevious) &&
      (prevFrameDisposalMethod != kDisposeRestorePrevious)) {
    // We are storing the whole image.
    // It would be better if we just stored the area that nextFrame is going to
    // overwrite.
    if (!mAnim->compositingPrevFrame) {
      mAnim->compositingPrevFrame = new imgFrame();
      nsresult rv = mAnim->compositingPrevFrame->Init(0, 0, mSize.width, mSize.height,
                                                      gfxASurface::ImageFormatARGB32);
      if (NS_FAILED(rv)) {
        mAnim->compositingPrevFrame = nullptr;
        return rv;
      }
    }

    CopyFrameImage(mAnim->compositingFrame, mAnim->compositingPrevFrame);
  }

  // blit next frame into it's correct spot
  DrawFrameTo(aNextFrame, mAnim->compositingFrame, nextFrameRect);

  // Set timeout of CompositeFrame to timeout of frame we just composed
  // Bug 177948
  int32_t timeout = aNextFrame->GetTimeout();
  mAnim->compositingFrame->SetTimeout(timeout);

  // Tell the image that it is fully 'downloaded'.
  nsresult rv = mAnim->compositingFrame->ImageUpdated(mAnim->compositingFrame->GetRect());
  if (NS_FAILED(rv)) {
    return rv;
  }

  // We don't want to keep composite images for 8bit frames.
  // Also this optimization won't work if the next frame has
  // kDisposeRestorePrevious, because it would need to be restored
  // into "after prev disposal but before next blend" state,
  // not into empty frame.
  if (isFullNextFrame && mAnimationMode == kNormalAnimMode && mLoopCount != 0 &&
      nextFrameDisposalMethod != kDisposeRestorePrevious &&
      !aNextFrame->GetIsPaletted()) {
    // We have a composited full frame
    // Store the composited frame into the mFrames[..] so we don't have to
    // continuously re-build it
    // Then set the previous frame's disposal to CLEAR_ALL so we just draw the
    // frame next time around
    if (CopyFrameImage(mAnim->compositingFrame, aNextFrame)) {
      aPrevFrame->SetFrameDisposalMethod(kDisposeClearAll);
      mAnim->lastCompositedFrameIndex = -1;
      return NS_OK;
    }
  }

  mAnim->lastCompositedFrameIndex = aNextFrameIndex;

  return NS_OK;
}

//******************************************************************************
// Fill aFrame with black. Does also clears the mask.
void
RasterImage::ClearFrame(imgFrame *aFrame)
{
  if (!aFrame)
    return;

  nsresult rv = aFrame->LockImageData();
  if (NS_FAILED(rv))
    return;

  nsRefPtr<gfxASurface> surf;
  aFrame->GetSurface(getter_AddRefs(surf));

  // Erase the surface to transparent
  gfxContext ctx(surf);
  ctx.SetOperator(gfxContext::OPERATOR_CLEAR);
  ctx.Paint();

  aFrame->UnlockImageData();
}

//******************************************************************************
void
RasterImage::ClearFrame(imgFrame *aFrame, nsIntRect &aRect)
{
  if (!aFrame || aRect.width <= 0 || aRect.height <= 0)
    return;

  nsresult rv = aFrame->LockImageData();
  if (NS_FAILED(rv))
    return;

  nsRefPtr<gfxASurface> surf;
  aFrame->GetSurface(getter_AddRefs(surf));

  // Erase the destination rectangle to transparent
  gfxContext ctx(surf);
  ctx.SetOperator(gfxContext::OPERATOR_CLEAR);
  ctx.Rectangle(gfxRect(aRect.x, aRect.y, aRect.width, aRect.height));
  ctx.Fill();

  aFrame->UnlockImageData();
}


//******************************************************************************
// Whether we succeed or fail will not cause a crash, and there's not much
// we can do about a failure, so there we don't return a nsresult
bool
RasterImage::CopyFrameImage(imgFrame *aSrcFrame,
                            imgFrame *aDstFrame)
{
  uint8_t* aDataSrc;
  uint8_t* aDataDest;
  uint32_t aDataLengthSrc;
  uint32_t aDataLengthDest;

  if (!aSrcFrame || !aDstFrame)
    return false;

  AutoFrameLocker dstLock(aDstFrame);
  AutoFrameLocker srcLock(aSrcFrame);

  if (!srcLock.Succeeded() || !dstLock.Succeeded()) {
    return false;
  }

  // Copy Image Over
  aSrcFrame->GetImageData(&aDataSrc, &aDataLengthSrc);
  aDstFrame->GetImageData(&aDataDest, &aDataLengthDest);
  if (!aDataDest || !aDataSrc || aDataLengthDest != aDataLengthSrc) {
    return false;
  }

  memcpy(aDataDest, aDataSrc, aDataLengthSrc);

  return true;
}

//******************************************************************************
/*
 * aSrc is the current frame being drawn,
 * aDst is the composition frame where the current frame is drawn into.
 * aSrcRect is the size of the current frame, and the position of that frame
 *          in the composition frame.
 */
nsresult
RasterImage::DrawFrameTo(imgFrame *aSrc,
                         imgFrame *aDst,
                         nsIntRect& aSrcRect)
{
  NS_ENSURE_ARG_POINTER(aSrc);
  NS_ENSURE_ARG_POINTER(aDst);

  AutoFrameLocker srcLock(aSrc);
  AutoFrameLocker dstLock(aDst);

  nsIntRect dstRect = aDst->GetRect();

  // According to both AGIF and APNG specs, offsets are unsigned
  if (aSrcRect.x < 0 || aSrcRect.y < 0) {
    NS_WARNING("RasterImage::DrawFrameTo: negative offsets not allowed");
    return NS_ERROR_FAILURE;
  }
  // Outside the destination frame, skip it
  if ((aSrcRect.x > dstRect.width) || (aSrcRect.y > dstRect.height)) {
    return NS_OK;
  }

  if (aSrc->GetIsPaletted()) {
    // Larger than the destination frame, clip it
    int32_t width = std::min(aSrcRect.width, dstRect.width - aSrcRect.x);
    int32_t height = std::min(aSrcRect.height, dstRect.height - aSrcRect.y);

    // The clipped image must now fully fit within destination image frame
    NS_ASSERTION((aSrcRect.x >= 0) && (aSrcRect.y >= 0) &&
                 (aSrcRect.x + width <= dstRect.width) &&
                 (aSrcRect.y + height <= dstRect.height),
                "RasterImage::DrawFrameTo: Invalid aSrcRect");

    // clipped image size may be smaller than source, but not larger
    NS_ASSERTION((width <= aSrcRect.width) && (height <= aSrcRect.height),
                 "RasterImage::DrawFrameTo: source must be smaller than dest");

    if (!srcLock.Succeeded() || !dstLock.Succeeded())
      return NS_ERROR_FAILURE;

    // Get pointers to image data
    uint32_t size;
    uint8_t *srcPixels;
    uint32_t *colormap;
    uint32_t *dstPixels;

    aSrc->GetImageData(&srcPixels, &size);
    aSrc->GetPaletteData(&colormap, &size);
    aDst->GetImageData((uint8_t **)&dstPixels, &size);
    if (!srcPixels || !dstPixels || !colormap) {
      return NS_ERROR_FAILURE;
    }

    // Skip to the right offset
    dstPixels += aSrcRect.x + (aSrcRect.y * dstRect.width);
    if (!aSrc->GetHasAlpha()) {
      for (int32_t r = height; r > 0; --r) {
        for (int32_t c = 0; c < width; c++) {
          dstPixels[c] = colormap[srcPixels[c]];
        }
        // Go to the next row in the source resp. destination image
        srcPixels += aSrcRect.width;
        dstPixels += dstRect.width;
      }
    } else {
      for (int32_t r = height; r > 0; --r) {
        for (int32_t c = 0; c < width; c++) {
          const uint32_t color = colormap[srcPixels[c]];
          if (color)
            dstPixels[c] = color;
        }
        // Go to the next row in the source resp. destination image
        srcPixels += aSrcRect.width;
        dstPixels += dstRect.width;
      }
    }

    return NS_OK;
  }

  nsRefPtr<gfxPattern> srcPatt;
  aSrc->GetPattern(getter_AddRefs(srcPatt));

  nsRefPtr<gfxASurface> dstSurf;
  aDst->GetSurface(getter_AddRefs(dstSurf));

  gfxContext dst(dstSurf);
  dst.Translate(gfxPoint(aSrcRect.x, aSrcRect.y));
  dst.Rectangle(gfxRect(0, 0, aSrcRect.width, aSrcRect.height), true);

  // first clear the surface if the blend flag says so
  int32_t blendMethod = aSrc->GetBlendMethod();
  if (blendMethod == kBlendSource) {
    gfxContext::GraphicsOperator defaultOperator = dst.CurrentOperator();
    dst.SetOperator(gfxContext::OPERATOR_CLEAR);
    dst.Fill();
    dst.SetOperator(defaultOperator);
  }
  dst.SetPattern(srcPatt);
  dst.Paint();

  return NS_OK;
}


/********* Methods to implement lazy allocation of nsIProperties object *************/
NS_IMETHODIMP
RasterImage::Get(const char *prop, const nsIID & iid, void * *result)
{
  if (!mProperties)
    return NS_ERROR_FAILURE;
  return mProperties->Get(prop, iid, result);
}

NS_IMETHODIMP
RasterImage::Set(const char *prop, nsISupports *value)
{
  if (!mProperties)
    mProperties = do_CreateInstance("@mozilla.org/properties;1");
  if (!mProperties)
    return NS_ERROR_OUT_OF_MEMORY;
  return mProperties->Set(prop, value);
}

NS_IMETHODIMP
RasterImage::Has(const char *prop, bool *_retval)
{
  NS_ENSURE_ARG_POINTER(_retval);
  if (!mProperties) {
    *_retval = false;
    return NS_OK;
  }
  return mProperties->Has(prop, _retval);
}

NS_IMETHODIMP
RasterImage::Undefine(const char *prop)
{
  if (!mProperties)
    return NS_ERROR_FAILURE;
  return mProperties->Undefine(prop);
}

NS_IMETHODIMP
RasterImage::GetKeys(uint32_t *count, char ***keys)
{
  if (!mProperties) {
    *count = 0;
    *keys = nullptr;
    return NS_OK;
  }
  return mProperties->GetKeys(count, keys);
}

void
RasterImage::Discard(bool force)
{
  MOZ_ASSERT(NS_IsMainThread());

  // We should be ok for discard
  NS_ABORT_IF_FALSE(force ? CanForciblyDiscard() : CanDiscard(), "Asked to discard but can't!");

  // We should never discard when we have an active decoder
  NS_ABORT_IF_FALSE(!mDecoder, "Asked to discard with open decoder!");

  // As soon as an image becomes animated, it becomes non-discardable and any
  // timers are cancelled.
  NS_ABORT_IF_FALSE(!mAnim, "Asked to discard for animated image!");

  // For post-operation logging
  int old_frame_count = mFrames.Length();

  // Delete all the decoded frames, then clear the array.
  for (int i = 0; i < old_frame_count; ++i)
    delete mFrames[i];
  mFrames.Clear();

  // Clear our downscaled frame.
  mScaleResult.status = SCALE_INVALID;
  mScaleResult.frame = nullptr;

  // Clear the last decoded multipart frame.
  delete mMultipartDecodedFrame;
  mMultipartDecodedFrame = nullptr;

  // Flag that we no longer have decoded frames for this image
  mDecoded = false;

  // Notify that we discarded
  if (mStatusTracker)
    mStatusTracker->OnDiscard();

  mDecodeRequest = nullptr;

  if (force)
    DiscardTracker::Remove(&mDiscardTrackerNode);

  // Log
  PR_LOG(GetCompressedImageAccountingLog(), PR_LOG_DEBUG,
         ("CompressedImageAccounting: discarded uncompressed image "
          "data from RasterImage %p (%s) - %d frames (cached count: %d); "
          "Total Containers: %d, Discardable containers: %d, "
          "Total source bytes: %lld, Source bytes for discardable containers %lld",
          this,
          mSourceDataMimeType.get(),
          old_frame_count,
          mFrames.Length(),
          num_containers,
          num_discardable_containers,
          total_source_bytes,
          discardable_source_bytes));
}

// Helper method to determine if we can discard an image
bool
RasterImage::CanDiscard() {
  return (DiscardingEnabled() && // Globally enabled...
          mDiscardable &&        // ...Enabled at creation time...
          (mLockCount == 0) &&   // ...not temporarily disabled...
          mHasSourceData &&      // ...have the source data...
          mDecoded);             // ...and have something to discard.
}

bool
RasterImage::CanForciblyDiscard() {
  return mDiscardable &&         // ...Enabled at creation time...
         mHasSourceData;         // ...have the source data...
}

// Helper method to tell us whether the clock is currently running for
// discarding this image. Mainly for assertions.
bool
RasterImage::DiscardingActive() {
  return mDiscardTrackerNode.isInList();
}

// Helper method to determine if we're storing the source data in a buffer
// or just writing it directly to the decoder
bool
RasterImage::StoringSourceData() const {
  return (mDecodeOnDraw || mDiscardable);
}


// Sets up a decoder for this image. It is an error to call this function
// when decoding is already in process (ie - when mDecoder is non-null).
nsresult
RasterImage::InitDecoder(bool aDoSizeDecode, bool aIsSynchronous /* = false */)
{
  // Ensure that the decoder is not already initialized
  NS_ABORT_IF_FALSE(!mDecoder, "Calling InitDecoder() while already decoding!");

  // We shouldn't be firing up a decoder if we already have the frames decoded
  NS_ABORT_IF_FALSE(!mDecoded, "Calling InitDecoder() but already decoded!");

  // Since we're not decoded, we should not have a discard timer active
  NS_ABORT_IF_FALSE(!DiscardingActive(), "Discard Timer active in InitDecoder()!");

  // Make sure we actually get size before doing a full decode.
  if (!aDoSizeDecode) {
    NS_ABORT_IF_FALSE(mHasSize, "Must do a size decode before a full decode!");
  }

  // Figure out which decoder we want
  eDecoderType type = GetDecoderType(mSourceDataMimeType.get());
  CONTAINER_ENSURE_TRUE(type != eDecoderType_unknown, NS_IMAGELIB_ERROR_NO_DECODER);

  // Instantiate the appropriate decoder
  switch (type) {
    case eDecoderType_png:
      mDecoder = new nsPNGDecoder(*this);
      break;
    case eDecoderType_gif:
      mDecoder = new nsGIFDecoder2(*this);
      break;
    case eDecoderType_jpeg:
      // If we have all the data we don't want to waste cpu time doing
      // a progressive decode
      mDecoder = new nsJPEGDecoder(*this,
                                   mHasBeenDecoded ? Decoder::SEQUENTIAL :
                                                     Decoder::PROGRESSIVE);
      break;
    case eDecoderType_bmp:
      mDecoder = new nsBMPDecoder(*this);
      break;
    case eDecoderType_ico:
      mDecoder = new nsICODecoder(*this);
      break;
    case eDecoderType_icon:
      mDecoder = new nsIconDecoder(*this);
      break;
#ifdef MOZ_WBMP
    case eDecoderType_wbmp:
      mDecoder = new nsWBMPDecoder(*this);
      break;
#endif
    default:
      NS_ABORT_IF_FALSE(0, "Shouldn't get here!");
  }

  // If we already have frames, we're probably in the multipart/x-mixed-replace
  // case. Regardless, we need to lock the last frame. Our invariant is that,
  // while we have a decoder open, the last frame is always locked.
  if (mFrames.Length() > 0) {
    imgFrame *curframe = mFrames.ElementAt(mFrames.Length() - 1);
    curframe->LockImageData();
  }

  // Initialize the decoder
  if (!mDecodeRequest) {
    mDecodeRequest = new DecodeRequest(this);
  }
  mDecoder->SetObserver(mDecodeRequest->mStatusTracker->GetDecoderObserver());
  mDecoder->SetSizeDecode(aDoSizeDecode);
  mDecoder->SetDecodeFlags(mFrameDecodeFlags);
  mDecoder->SetSynchronous(aIsSynchronous);
  if (!aDoSizeDecode) {
    // We already have the size; tell the decoder so it can preallocate a
    // frame.  By default, we create an ARGB frame with no offset. If decoders
    // need a different type, they need to ask for it themselves.
    mDecoder->NeedNewFrame(0, 0, 0, mSize.width, mSize.height,
                           gfxASurface::ImageFormatARGB32);
    mDecoder->AllocateFrame();
  }
  mDecoder->Init();
  CONTAINER_ENSURE_SUCCESS(mDecoder->GetDecoderError());

  if (!aDoSizeDecode) {
    Telemetry::GetHistogramById(Telemetry::IMAGE_DECODE_COUNT)->Subtract(mDecodeCount);
    mDecodeCount++;
    Telemetry::GetHistogramById(Telemetry::IMAGE_DECODE_COUNT)->Add(mDecodeCount);

    if (mDecodeCount > sMaxDecodeCount) {
      // Don't subtract out 0 from the histogram, because that causes its count
      // to go negative, which is not kosher.
      if (sMaxDecodeCount > 0) {
        Telemetry::GetHistogramById(Telemetry::IMAGE_MAX_DECODE_COUNT)->Subtract(sMaxDecodeCount);
      }
      sMaxDecodeCount = mDecodeCount;
      Telemetry::GetHistogramById(Telemetry::IMAGE_MAX_DECODE_COUNT)->Add(sMaxDecodeCount);
    }
  }

  return NS_OK;
}

// Flushes, closes, and nulls-out a decoder. Cleans up any related decoding
// state. It is an error to call this function when there is no initialized
// decoder.
//
// aIntent specifies the intent of the shutdown. If aIntent is
// eShutdownIntent_Done, an error is flagged if we didn't get what we should
// have out of the decode. If aIntent is eShutdownIntent_NotNeeded, we don't
// check this. If aIntent is eShutdownIntent_Error, we shut down in error mode.
nsresult
RasterImage::ShutdownDecoder(eShutdownIntent aIntent)
{
  MOZ_ASSERT(NS_IsMainThread());
  mDecodingMutex.AssertCurrentThreadOwns();

  // Ensure that our intent is valid
  NS_ABORT_IF_FALSE((aIntent >= 0) && (aIntent < eShutdownIntent_AllCount),
                    "Invalid shutdown intent");

  // Ensure that the decoder is initialized
  NS_ABORT_IF_FALSE(mDecoder, "Calling ShutdownDecoder() with no active decoder!");

  // Figure out what kind of decode we were doing before we get rid of our decoder
  bool wasSizeDecode = mDecoder->IsSizeDecode();

  // Unlock the last frame (if we have any). Our invariant is that, while we
  // have a decoder open, the last frame is always locked.
  if (mFrames.Length() > 0) {
    imgFrame *curframe = mFrames.ElementAt(mFrames.Length() - 1);
    curframe->UnlockImageData();
  }

  // Finalize the decoder
  // null out mDecoder, _then_ check for errors on the close (otherwise the
  // error routine might re-invoke ShutdownDecoder)
  nsRefPtr<Decoder> decoder = mDecoder;
  mDecoder = nullptr;

  mFinishing = true;
  mInDecoder = true;
  decoder->Finish(aIntent);
  mInDecoder = false;
  mFinishing = false;

  // Kill off our decode request, if it's pending.  (If not, this call is
  // harmless.)
  DecodePool::StopDecoding(this);

  nsresult decoderStatus = decoder->GetDecoderError();
  if (NS_FAILED(decoderStatus)) {
    DoError();
    return decoderStatus;
  }

  // We just shut down the decoder. If we didn't get what we want, but expected
  // to, flag an error
  bool failed = false;
  if (wasSizeDecode && !mHasSize)
    failed = true;
  if (!wasSizeDecode && !mDecoded)
    failed = true;
  if ((aIntent == eShutdownIntent_Done) && failed) {
    DoError();
    return NS_ERROR_FAILURE;
  }

  // If we finished a full decode, and we're not meant to be storing source
  // data, stop storing it.
  if (!wasSizeDecode && !StoringSourceData()) {
    mSourceData.Clear();
  }

  mBytesDecoded = 0;

  return NS_OK;
}

// Writes the data to the decoder, updating the total number of bytes written.
nsresult
RasterImage::WriteToDecoder(const char *aBuffer, uint32_t aCount)
{
  mDecodingMutex.AssertCurrentThreadOwns();

  // We should have a decoder
  NS_ABORT_IF_FALSE(mDecoder, "Trying to write to null decoder!");

  // Write
  nsRefPtr<Decoder> kungFuDeathGrip = mDecoder;
  mInDecoder = true;
  mDecoder->Write(aBuffer, aCount);
  mInDecoder = false;

  CONTAINER_ENSURE_SUCCESS(mDecoder->GetDecoderError());

  // Keep track of the total number of bytes written over the lifetime of the
  // decoder
  mBytesDecoded += aCount;

  return NS_OK;
}

// This function is called in situations where it's clear that we want the
// frames in decoded form (Draw, GetFrame, etc).  If we're completely decoded,
// this method resets the discard timer (if we're discardable), since wanting
// the frames now is a good indicator of wanting them again soon. If we're not
// decoded, this method kicks off asynchronous decoding to generate the frames.
nsresult
RasterImage::WantDecodedFrames()
{
  nsresult rv;

  // If we can discard, the clock should be running. Reset it.
  if (CanDiscard()) {
    NS_ABORT_IF_FALSE(DiscardingActive(),
                      "Decoded and discardable but discarding not activated!");
    rv = DiscardTracker::Reset(&mDiscardTrackerNode);
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  // Request a decode (no-op if we're decoded)
  return StartDecoding();
}

//******************************************************************************
/* void requestDecode() */
NS_IMETHODIMP
RasterImage::RequestDecode()
{
  return RequestDecodeCore(ASYNCHRONOUS);
}

/* void startDecode() */
NS_IMETHODIMP
RasterImage::StartDecoding()
{
  return RequestDecodeCore(SOMEWHAT_SYNCHRONOUS);
}


NS_IMETHODIMP
RasterImage::RequestDecodeCore(RequestDecodeType aDecodeType)
{
  MOZ_ASSERT(NS_IsMainThread());

  nsresult rv;

  if (mError)
    return NS_ERROR_FAILURE;

  // If we've already got a full decoder running, and have already
  // decoded some bytes, we have nothing to do
  if (mDecoder && !mDecoder->IsSizeDecode() && mBytesDecoded) {
    return NS_OK;
  }

  // mFinishing protects against the case when we enter RequestDecode from
  // ShutdownDecoder -- in that case, we're done with the decode, we're just
  // not quite ready to admit it.  See bug 744309.
  if (mFinishing)
    return NS_OK;

  // If our callstack goes through a size decoder, we have a problem.
  // We need to shutdown the size decode and replace it with  a full
  // decoder, but can't do that from within the decoder itself. Thus, we post
  // an asynchronous event to the event loop to do it later. Since
  // RequestDecode() is an asynchronous function this works fine (though it's
  // a little slower).
  if (mInDecoder) {
    nsRefPtr<imgDecodeRequestor> requestor = new imgDecodeRequestor(*this);
    return NS_DispatchToCurrentThread(requestor);
  }

  // If we have a size decoder open, make sure we get the size
  if (mDecoder && mDecoder->IsSizeDecode()) {
    nsresult rv = DecodePool::Singleton()->DecodeUntilSizeAvailable(this);
    CONTAINER_ENSURE_SUCCESS(rv);

    // If we didn't get the size out of the image, we won't until we get more
    // data, so signal that we want a full decode and give up for now.
    if (!mHasSize) {
      mWantFullDecode = true;
      return NS_OK;
    }
  }

  // If we're fully decoded, we have nothing to do. This has to be after
  // DecodeUntilSizeAvailable because it can result in a synchronous decode if
  // we're already waiting on a full decode.
  if (mDecoded)
    return NS_OK;

  MutexAutoLock lock(mDecodingMutex);

  // If we have a size decode open, interrupt it and shut it down; or if
  // the decoder has different flags than what we need
  if (mDecoder && mDecoder->GetDecodeFlags() != mFrameDecodeFlags) {
    nsresult rv = FinishedSomeDecoding(eShutdownIntent_NotNeeded);
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  // If we don't have a decoder, create one
  if (!mDecoder) {
    rv = InitDecoder(/* aDoSizeDecode = */ false);
    CONTAINER_ENSURE_SUCCESS(rv);

    rv = FinishedSomeDecoding();
    CONTAINER_ENSURE_SUCCESS(rv);

    MOZ_ASSERT(mDecoder);
  }

  // If we're waiting for decode work to be notified, go ahead and do that.
  if (mDecodeRequest &&
      mDecodeRequest->mRequestStatus == DecodeRequest::REQUEST_WORK_DONE) {
    nsresult rv = FinishedSomeDecoding();
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  // If we've read all the data we have, we're done
  if (mHasSourceData && mBytesDecoded == mSourceData.Length())
    return NS_OK;

  // If we can do decoding now, do so.  Small images will decode completely,
  // large images will decode a bit and post themselves to the event loop
  // to finish decoding.
  if (!mDecoded && !mInDecoder && mHasSourceData && aDecodeType == SOMEWHAT_SYNCHRONOUS) {
    PROFILER_LABEL_PRINTF("RasterImage", "DecodeABitOf", "%s", GetURIString().get());
    mDecoder->SetSynchronous(true);

    DecodePool::Singleton()->DecodeABitOf(this);

    // DecodeABitOf can destroy mDecoder.
    if (mDecoder) {
      mDecoder->SetSynchronous(false);
    }
    return NS_OK;
  }

  if (!mDecoded) {
    // If we get this far, dispatch the worker. We do this instead of starting
    // any immediate decoding to guarantee that all our decode notifications are
    // dispatched asynchronously, and to ensure we stay responsive.
    DecodePool::Singleton()->RequestDecode(this);
  }

  return NS_OK;
}

// Synchronously decodes as much data as possible
nsresult
RasterImage::SyncDecode()
{
  MutexAutoLock imgLock(mDecodingMutex);

  if (mDecodeRequest) {
    // If the image is waiting for decode work to be notified, go ahead and do that.
    if (mDecodeRequest->mRequestStatus == DecodeRequest::REQUEST_WORK_DONE) {
      nsresult rv = FinishedSomeDecoding();
      CONTAINER_ENSURE_SUCCESS(rv);
    }
  }

  nsresult rv;

  PROFILER_LABEL_PRINTF("RasterImage", "SyncDecode", "%s", GetURIString().get());;

  // We really have no good way of forcing a synchronous decode if we're being
  // called in a re-entrant manner (ie, from an event listener fired by a
  // decoder), because the decoding machinery is already tied up. We thus explicitly
  // disallow this type of call in the API, and check for it in API methods.
  NS_ABORT_IF_FALSE(!mInDecoder, "Yikes, forcing sync in reentrant call!");

  // If we have a size decoder open, make sure we get the size
  if (mDecoder && mDecoder->IsSizeDecode()) {
    nsresult rv = DecodePool::Singleton()->DecodeUntilSizeAvailable(this);
    CONTAINER_ENSURE_SUCCESS(rv);

    // If we didn't get the size out of the image, we won't until we get more
    // data, so signal that we want a full decode and give up for now.
    if (!mHasSize) {
      mWantFullDecode = true;
      return NS_ERROR_NOT_AVAILABLE;
    }
  }

  // If we're decoded already, or decoding until the size was available
  // finished us as a side-effect, no worries
  if (mDecoded)
    return NS_OK;

  // If we have a decoder open with different flags than what we need, shut it
  // down
  if (mDecoder && mDecoder->GetDecodeFlags() != mFrameDecodeFlags) {
    nsresult rv = FinishedSomeDecoding(eShutdownIntent_NotNeeded);
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  // If we're currently waiting on a new frame for this image, we have to create
  // it now.
  if (mDecoder && mDecoder->NeedsNewFrame()) {
    mDecoder->AllocateFrame();
    mDecodeRequest->mAllocatedNewFrame = true;
  }

  // If we don't have a decoder, create one
  if (!mDecoder) {
    rv = InitDecoder(/* aDoSizeDecode = */ false, /* aIsSynchronous = */ true);
    CONTAINER_ENSURE_SUCCESS(rv);
  } else {
    mDecoder->SetSynchronous(true);
  }

  // Write everything we have
  rv = DecodeSomeData(mSourceData.Length() - mBytesDecoded);
  CONTAINER_ENSURE_SUCCESS(rv);

  // When we're doing a sync decode, we want to get as much information from the
  // image as possible. We've send the decoder all of our data, so now's a good
  // time  to flush any invalidations (in case we don't have all the data and what
  // we got left us mid-frame).
  nsRefPtr<Decoder> kungFuDeathGrip = mDecoder;
  mInDecoder = true;
  mDecoder->FlushInvalidations();
  mInDecoder = false;

  rv = FinishedSomeDecoding();
  CONTAINER_ENSURE_SUCCESS(rv);

  if (mDecoder) {
    mDecoder->SetSynchronous(false);

    // If our decoder's still open, there's still work to be done.
    DecodePool::Singleton()->RequestDecode(this);
  }

  // All good if no errors!
  return mError ? NS_ERROR_FAILURE : NS_OK;
}

bool
RasterImage::CanQualityScale(const gfxSize& scale)
{
  // If target size is 1:1 with original, don't scale.
  if (scale.width == 1.0 && scale.height == 1.0)
    return false;

  // To save memory don't quality upscale images bigger than the limit.
  if (scale.width > 1.0 || scale.height > 1.0) {
    uint32_t scaled_size = static_cast<uint32_t>(mSize.width * mSize.height * scale.width * scale.height);
    if (scaled_size > gHQUpscalingMaxSize)
      return false;
  }

  return true;
}

bool
RasterImage::CanScale(gfxPattern::GraphicsFilter aFilter,
                      gfxSize aScale)
{
// The high-quality scaler requires Skia.
#ifdef MOZ_ENABLE_SKIA
  // We don't use the scaler for animated or multipart images to avoid doing a
  // bunch of work on an image that just gets thrown away.
  if (gHQDownscaling && aFilter == gfxPattern::FILTER_GOOD &&
      !mAnim && mDecoded && !mMultipart && CanQualityScale(aScale)) {
    gfxFloat factor = gHQDownscalingMinFactor / 1000.0;

    return (aScale.width < factor || aScale.height < factor);
  }
#endif

  return false;
}

void
RasterImage::ScalingStart(ScaleRequest* request)
{
  MOZ_ASSERT(request);
  mScaleResult.scale = request->scale;
  mScaleResult.status = SCALE_PENDING;
  mScaleRequest = request;
}

void
RasterImage::ScalingDone(ScaleRequest* request, ScaleStatus status)
{
  MOZ_ASSERT(status == SCALE_DONE || status == SCALE_INVALID);
  MOZ_ASSERT(request);

  if (status == SCALE_DONE) {
    MOZ_ASSERT(request->done);

    if (mStatusTracker) {
      imgFrame *scaledFrame = request->dstFrame.get();
      scaledFrame->ImageUpdated(scaledFrame->GetRect());
      mStatusTracker->FrameChanged(&request->srcRect);
    }

    mScaleResult.status = SCALE_DONE;
    mScaleResult.frame = request->dstFrame;
    mScaleResult.scale = request->scale;
  } else {
    mScaleResult.status = SCALE_INVALID;
    mScaleResult.frame = nullptr;
  }

  // If we were waiting for this scale to come through, forget the scale
  // request. Otherwise, we still have a scale outstanding that it's possible
  // for us to (want to) stop.
  if (mScaleRequest == request) {
    mScaleRequest = nullptr;
  }
}

void
RasterImage::DrawWithPreDownscaleIfNeeded(imgFrame *aFrame,
                                          gfxContext *aContext,
                                          gfxPattern::GraphicsFilter aFilter,
                                          const gfxMatrix &aUserSpaceToImageSpace,
                                          const gfxRect &aFill,
                                          const nsIntRect &aSubimage)
{
  imgFrame *frame = aFrame;
  nsIntRect framerect = frame->GetRect();
  gfxMatrix userSpaceToImageSpace = aUserSpaceToImageSpace;
  gfxMatrix imageSpaceToUserSpace = aUserSpaceToImageSpace;
  imageSpaceToUserSpace.Invert();
  gfxSize scale = imageSpaceToUserSpace.ScaleFactors(true);
  nsIntRect subimage = aSubimage;

  if (CanScale(aFilter, scale)) {
    // If scale factor is still the same that we scaled for and
    // ScaleWorker isn't still working, then we can use pre-downscaled frame.
    // If scale factor has changed, order new request.
    // FIXME: Current implementation doesn't support pre-downscale
    // mechanism for multiple sizes from same src, since we cache
    // pre-downscaled frame only for the latest requested scale.
    // The solution is to cache more than one scaled image frame
    // for each RasterImage.
    if (mScaleResult.status == SCALE_DONE && mScaleResult.scale == scale) {
      frame = mScaleResult.frame;
      userSpaceToImageSpace.Multiply(gfxMatrix().Scale(scale.width, scale.height));

      // Since we're switching to a scaled image, we need to transform the
      // area of the subimage to draw accordingly, since imgFrame::Draw()
      // doesn't know about scaled frames.
      subimage.ScaleRoundOut(scale.width, scale.height);
    }

    // If we're not waiting for exactly this result, and there's only one
    // instance of this image on this page, ask for a scale.
    else if (!(mScaleResult.status == SCALE_PENDING && mScaleResult.scale == scale) &&
             mLockCount == 1) {
      // If we have an oustanding request, signal it to stop (if it can).
      if (mScaleRequest) {
        mScaleRequest->stopped = true;
      }

      nsRefPtr<ScaleRunner> runner = new ScaleRunner(this, scale, frame);
      if (runner->IsOK()) {
        if (!sScaleWorkerThread) {
          NS_NewNamedThread("Image Scaler", getter_AddRefs(sScaleWorkerThread));
          ClearOnShutdown(&sScaleWorkerThread);
        }

        sScaleWorkerThread->Dispatch(runner, NS_DISPATCH_NORMAL);
      }
    }
  }

  nsIntMargin padding(framerect.y,
                      mSize.width - framerect.XMost(),
                      mSize.height - framerect.YMost(),
                      framerect.x);

  frame->Draw(aContext, aFilter, userSpaceToImageSpace, aFill, padding, subimage);
}

//******************************************************************************
/* [noscript] void draw(in gfxContext aContext,
 *                      in gfxGraphicsFilter aFilter,
 *                      [const] in gfxMatrix aUserSpaceToImageSpace,
 *                      [const] in gfxRect aFill,
 *                      [const] in nsIntRect aSubimage,
 *                      [const] in nsIntSize aViewportSize,
 *                      [const] in SVGImageContext aSVGContext,
 *                      in uint32_t aWhichFrame,
 *                      in uint32_t aFlags); */
NS_IMETHODIMP
RasterImage::Draw(gfxContext *aContext,
                  gfxPattern::GraphicsFilter aFilter,
                  const gfxMatrix &aUserSpaceToImageSpace,
                  const gfxRect &aFill,
                  const nsIntRect &aSubimage,
                  const nsIntSize& /*aViewportSize - ignored*/,
                  const SVGImageContext* /*aSVGContext - ignored*/,
                  uint32_t aWhichFrame,
                  uint32_t aFlags)
{
  if (aWhichFrame > FRAME_MAX_VALUE)
    return NS_ERROR_INVALID_ARG;

  if (mError)
    return NS_ERROR_FAILURE;

  // Disallowed in the API
  if (mInDecoder && (aFlags & imgIContainer::FLAG_SYNC_DECODE))
    return NS_ERROR_FAILURE;

  // Illegal -- you can't draw with non-default decode flags.
  // (Disabling colorspace conversion might make sense to allow, but
  // we don't currently.)
  if ((aFlags & DECODE_FLAGS_MASK) != DECODE_FLAGS_DEFAULT)
    return NS_ERROR_FAILURE;

  NS_ENSURE_ARG_POINTER(aContext);

  // We can only draw with the default decode flags
  if (mFrameDecodeFlags != DECODE_FLAGS_DEFAULT) {
    if (!CanForciblyDiscard())
      return NS_ERROR_NOT_AVAILABLE;
    ForceDiscard();

    mFrameDecodeFlags = DECODE_FLAGS_DEFAULT;
  }

  // If this image is a candidate for discarding, reset its position in the
  // discard tracker so we're less likely to discard it right away.
  //
  // (We don't normally draw unlocked images, so this conditition will usually
  // be false.  But we will draw unlocked images if image locking is globally
  // disabled via the content.image.allow_locking pref.)
  if (DiscardingActive()) {
    DiscardTracker::Reset(&mDiscardTrackerNode);
  }

  // We would like to just check if we have a zero lock count, but we can't do
  // that for animated images because in EnsureAnimExists we lock the image and
  // never unlock so that animated images always have their lock count >= 1. In
  // that case we use our animation consumers count as a proxy for lock count.
  if (mLockCount == 0 || (mAnim && mAnimationConsumers == 0)) {
    if (mStatusTracker)
      mStatusTracker->OnUnlockedDraw();
  }

  // We use !mDecoded && mHasSourceData to mean discarded.
  if (!mDecoded && mHasSourceData) {
    mDrawStartTime = TimeStamp::Now();
  }

  // If a synchronous draw is requested, flush anything that might be sitting around
  if (aFlags & FLAG_SYNC_DECODE) {
    nsresult rv = SyncDecode();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  uint32_t frameIndex = aWhichFrame == FRAME_FIRST ? 0
                                                   : GetCurrentImgFrameIndex();
  imgFrame* frame = GetDrawableImgFrame(frameIndex);
  if (!frame) {
    return NS_OK; // Getting the frame (above) touches the image and kicks off decoding
  }

  DrawWithPreDownscaleIfNeeded(frame, aContext, aFilter, aUserSpaceToImageSpace, aFill, aSubimage);

  if (mDecoded && !mDrawStartTime.IsNull()) {
      TimeDuration drawLatency = TimeStamp::Now() - mDrawStartTime;
      Telemetry::Accumulate(Telemetry::IMAGE_DECODE_ON_DRAW_LATENCY, int32_t(drawLatency.ToMicroseconds()));
      // clear the value of mDrawStartTime
      mDrawStartTime = TimeStamp();
  }

  return NS_OK;
}

//******************************************************************************
/* void lockImage() */
NS_IMETHODIMP
RasterImage::LockImage()
{
  if (mError)
    return NS_ERROR_FAILURE;

  // Cancel the discard timer if it's there
  DiscardTracker::Remove(&mDiscardTrackerNode);

  // Increment the lock count
  mLockCount++;

  return NS_OK;
}

//******************************************************************************
/* void unlockImage() */
NS_IMETHODIMP
RasterImage::UnlockImage()
{
  if (mError)
    return NS_ERROR_FAILURE;

  // It's an error to call this function if the lock count is 0
  NS_ABORT_IF_FALSE(mLockCount > 0,
                    "Calling UnlockImage with mLockCount == 0!");
  if (mLockCount == 0)
    return NS_ERROR_ABORT;

  // We're locked, so discarding should not be active
  NS_ABORT_IF_FALSE(!DiscardingActive(), "Locked, but discarding activated");

  // Decrement our lock count
  mLockCount--;

  // If we've decoded this image once before, we're currently decoding again,
  // and our lock count is now zero (so nothing is forcing us to keep the
  // decoded data around), try to cancel the decode and throw away whatever
  // we've decoded.
  if (mHasBeenDecoded && mDecoder &&
      mLockCount == 0 && CanForciblyDiscard()) {
    PR_LOG(GetCompressedImageAccountingLog(), PR_LOG_DEBUG,
           ("RasterImage[0x%p] canceling decode because image "
            "is now unlocked.", this));
    MutexAutoLock lock(mDecodingMutex);
    FinishedSomeDecoding(eShutdownIntent_NotNeeded);
    ForceDiscard();
    return NS_OK;
  }

  // Otherwise, we might still be a candidate for discarding in the future.  If
  // we are, add ourselves to the discard tracker.
  if (CanDiscard()) {
    nsresult rv = DiscardTracker::Reset(&mDiscardTrackerNode);
    CONTAINER_ENSURE_SUCCESS(rv);
  }

  return NS_OK;
}

//******************************************************************************
/* void requestDiscard() */
NS_IMETHODIMP
RasterImage::RequestDiscard()
{
  if (CanDiscard()) {
    ForceDiscard();
  }

  return NS_OK;
}

// Flushes up to aMaxBytes to the decoder.
nsresult
RasterImage::DecodeSomeData(uint32_t aMaxBytes)
{
  // We should have a decoder if we get here
  NS_ABORT_IF_FALSE(mDecoder, "trying to decode without decoder!");

  mDecodingMutex.AssertCurrentThreadOwns();

  // First, if we've just been called because we allocated a frame on the main
  // thread, let the decoder deal with the data it set aside at that time by
  // passing it a null buffer.
  if (mDecodeRequest->mAllocatedNewFrame) {
    mDecodeRequest->mAllocatedNewFrame = false;
    nsresult rv = WriteToDecoder(nullptr, 0);
    if (NS_FAILED(rv) || mDecoder->NeedsNewFrame()) {
      return rv;
    }
  }

  // If we have nothing else to decode, return
  if (mBytesDecoded == mSourceData.Length())
    return NS_OK;

  // write the proper amount of data
  uint32_t bytesToDecode = std::min(aMaxBytes,
                                    mSourceData.Length() - mBytesDecoded);
  nsresult rv = WriteToDecoder(mSourceData.Elements() + mBytesDecoded,
                               bytesToDecode);

  return rv;
}

// There are various indicators that tell us we're finished with the decode
// task at hand and can shut down the decoder.
//
// This method may not be called if there is no decoder.
bool
RasterImage::IsDecodeFinished()
{
  // Precondition
  mDecodingMutex.AssertCurrentThreadOwns();
  NS_ABORT_IF_FALSE(mDecoder, "Can't call IsDecodeFinished() without decoder!");

  // The decode is complete if we got what we wanted.
  if (mDecoder->IsSizeDecode()) {
    if (mDecoder->HasSize()) {
      return true;
    }
  } else if (mDecoder->GetDecodeDone()) {
    return true;
  }

  // If the decoder returned because it needed a new frame and we haven't
  // written to it since then, the decoder may be storing data that it hasn't
  // decoded yet.
  if (mDecoder->NeedsNewFrame() ||
      (mDecodeRequest && mDecodeRequest->mAllocatedNewFrame)) {
    return false;
  }

  // Otherwise, if we have all the source data and wrote all the source data,
  // we're done.
  //
  // (NB - This can be the case even for non-erroneous images because
  // Decoder::GetDecodeDone() might not return true until after we call
  // Decoder::Finish() in ShutdownDecoder())
  if (mHasSourceData && (mBytesDecoded == mSourceData.Length())) {
    return true;
  }

  // If we get here, assume it's not finished.
  return false;
}

// Indempotent error flagging routine. If a decoder is open, shuts it down.
void
RasterImage::DoError()
{
  // If we've flagged an error before, we have nothing to do
  if (mError)
    return;

  // If we're mid-decode, shut down the decoder.
  if (mDecoder) {
    MutexAutoLock lock(mDecodingMutex);
    FinishedSomeDecoding(eShutdownIntent_Error);
  }

  // Put the container in an error state
  mError = true;

  if (mDecodeRequest) {
    mDecodeRequest->mStatusTracker->GetDecoderObserver()->OnError();
  } else {
    mStatusTracker->GetDecoderObserver()->OnError();
  }

  // Log our error
  LOG_CONTAINER_ERROR;
}

// nsIInputStream callback to copy the incoming image data directly to the
// RasterImage without processing. The RasterImage is passed as the closure.
// Always reads everything it gets, even if the data is erroneous.
NS_METHOD
RasterImage::WriteToRasterImage(nsIInputStream* /* unused */,
                                void*          aClosure,
                                const char*    aFromRawSegment,
                                uint32_t       /* unused */,
                                uint32_t       aCount,
                                uint32_t*      aWriteCount)
{
  // Retrieve the RasterImage
  RasterImage* image = static_cast<RasterImage*>(aClosure);

  // Copy the source data. Unless we hit OOM, we squelch the return value
  // here, because returning an error means that ReadSegments stops
  // reading data, violating our invariant that we read everything we get.
  // If we hit OOM then we fail and the load is aborted.
  nsresult rv = image->AddSourceData(aFromRawSegment, aCount);
  if (rv == NS_ERROR_OUT_OF_MEMORY) {
    image->DoError();
    return rv;
  }

  // We wrote everything we got
  *aWriteCount = aCount;

  return NS_OK;
}

bool
RasterImage::ShouldAnimate()
{
  return ImageResource::ShouldAnimate() && mFrames.Length() >= 2 &&
         !mAnimationFinished;
}

/* readonly attribute uint32_t framesNotified; */
#ifdef DEBUG
NS_IMETHODIMP
RasterImage::GetFramesNotified(uint32_t *aFramesNotified)
{
  NS_ENSURE_ARG_POINTER(aFramesNotified);

  *aFramesNotified = mFramesNotified;

  return NS_OK;
}
#endif

nsresult
RasterImage::FinishedSomeDecoding(eShutdownIntent aIntent /* = eShutdownIntent_Done */,
                                  DecodeRequest* aRequest /* = nullptr */)
{
  MOZ_ASSERT(NS_IsMainThread());

  mDecodingMutex.AssertCurrentThreadOwns();

  nsRefPtr<DecodeRequest> request;
  if (aRequest) {
    request = aRequest;
  } else {
    request = mDecodeRequest;
  }

  // Ensure that, if the decoder is the last reference to the image, we don't
  // destroy it by destroying the decoder.
  nsRefPtr<RasterImage> image(this);

  bool done = false;
  bool wasSize = false;
  nsresult rv = NS_OK;

  if (image->mDecoder) {
    image->mDecoder->MarkFrameDirty();

    if (request && request->mChunkCount && !image->mDecoder->IsSizeDecode()) {
      Telemetry::Accumulate(Telemetry::IMAGE_DECODE_CHUNKS, request->mChunkCount);
    }

    if (!image->mHasSize && image->mDecoder->HasSize()) {
      image->mDecoder->SetSizeOnImage();
    }

    // If the decode finished, or we're specifically being told to shut down,
    // tell the image and shut down the decoder.
    if (image->IsDecodeFinished() || aIntent != eShutdownIntent_Done) {
      done = true;

      // Hold on to a reference to the decoder until we're done with it
      nsRefPtr<Decoder> decoder = image->mDecoder;

      wasSize = decoder->IsSizeDecode();

      // We need to shut down the decoder first, in order to ensure all
      // decoding routines have been finished.
      rv = image->ShutdownDecoder(aIntent);
      if (NS_FAILED(rv)) {
        image->DoError();
      }

      // Do some telemetry if this isn't a size decode.
      if (request && !decoder->IsSizeDecode()) {
        Telemetry::Accumulate(Telemetry::IMAGE_DECODE_TIME,
                              int32_t(request->mDecodeTime.ToMicroseconds()));

        // We record the speed for only some decoders. The rest have
        // SpeedHistogram return HistogramCount.
        Telemetry::ID id = decoder->SpeedHistogram();
        if (id < Telemetry::HistogramCount) {
          int32_t KBps = int32_t(request->mImage->mBytesDecoded /
                                 (1024 * request->mDecodeTime.ToSeconds()));
          Telemetry::Accumulate(id, KBps);
        }
      }
    }
  }

  imgStatusTracker::StatusDiff diff;
  if (request) {
    diff = image->mStatusTracker->CalculateAndApplyDifference(request->mStatusTracker);
  }

  {
    // Notifications can't go out with the decoding lock held.
    MutexAutoUnlock unlock(mDecodingMutex);

    // Then, tell the observers what happened in the decoder.
    // If we have no request, we have not yet created a decoder, but we still
    // need to send out notifications.
    if (request) {
      image->mStatusTracker->SyncNotifyDifference(diff);
    } else {
      image->mStatusTracker->SyncNotifyDecodeState();
    }

    // If we were a size decode and a full decode was requested, now's the time.
    if (NS_SUCCEEDED(rv) && aIntent != eShutdownIntent_Error && done &&
        wasSize && image->mWantFullDecode) {
      image->mWantFullDecode = false;

      // If we're not meant to be storing source data and we just got the size,
      // we need to synchronously flush all the data we got to a full decoder.
      // When that decoder is shut down, we'll also clear our source data.
      if (!image->StoringSourceData()) {
        rv = image->SyncDecode();
      } else {
        rv = image->RequestDecode();
      }
    }

  }

  return rv;
}

NS_IMPL_THREADSAFE_ISUPPORTS1(RasterImage::DecodePool,
                              nsIObserver)

/* static */ RasterImage::DecodePool*
RasterImage::DecodePool::Singleton()
{
  if (!sSingleton) {
    MOZ_ASSERT(NS_IsMainThread());
    sSingleton = new DecodePool();
    ClearOnShutdown(&sSingleton);
  }

  return sSingleton;
}

RasterImage::DecodePool::DecodePool()
 : mThreadPoolMutex("Thread Pool")
{
  if (gMultithreadedDecoding) {
    mThreadPool = do_CreateInstance(NS_THREADPOOL_CONTRACTID);
    if (mThreadPool) {
      mThreadPool->SetName(NS_LITERAL_CSTRING("ImageDecoder"));
      uint32_t limit;
      if (gDecodingThreadLimit <= 0) {
        limit = std::max(PR_GetNumberOfProcessors(), 2) - 1;
      } else {
        limit = static_cast<uint32_t>(gDecodingThreadLimit);
      }

      mThreadPool->SetThreadLimit(limit);
      mThreadPool->SetIdleThreadLimit(limit);

      nsCOMPtr<nsIObserverService> obsSvc = mozilla::services::GetObserverService();
      if (obsSvc) {
        obsSvc->AddObserver(this, "xpcom-shutdown-threads", false);
      }
    }
  }
}

RasterImage::DecodePool::~DecodePool()
{
  MOZ_ASSERT(NS_IsMainThread(), "Must shut down DecodePool on main thread!");
}

NS_IMETHODIMP
RasterImage::DecodePool::Observe(nsISupports *subject, const char *topic,
                                 const PRUnichar *data)
{
  NS_ASSERTION(strcmp(topic, "xpcom-shutdown-threads") == 0, "oops");

  nsCOMPtr<nsIThreadPool> threadPool;

  {
    MutexAutoLock threadPoolLock(mThreadPoolMutex);
    threadPool = mThreadPool;
    mThreadPool = nullptr;
  }

  if (threadPool) {
    threadPool->Shutdown();
  }

  return NS_OK;
}

void
RasterImage::DecodePool::RequestDecode(RasterImage* aImg)
{
  MOZ_ASSERT(aImg->mDecoder);
  aImg->mDecodingMutex.AssertCurrentThreadOwns();

  // If we're currently waiting on a new frame for this image, we can't do any
  // decoding.
  if (!aImg->mDecoder->NeedsNewFrame()) {
    // No matter whether this is currently being decoded, we need to update the
    // number of bytes we want it to decode.
    aImg->mDecodeRequest->mBytesToDecode = aImg->mSourceData.Length() - aImg->mBytesDecoded;

    if (aImg->mDecodeRequest->mRequestStatus == DecodeRequest::REQUEST_PENDING ||
        aImg->mDecodeRequest->mRequestStatus == DecodeRequest::REQUEST_ACTIVE) {
      // The image is already in our list of images to decode, or currently being
      // decoded, so we don't have to do anything else.
      return;
    }

    aImg->mDecodeRequest->mRequestStatus = DecodeRequest::REQUEST_PENDING;
    nsRefPtr<DecodeJob> job = new DecodeJob(aImg->mDecodeRequest, aImg);

    MutexAutoLock threadPoolLock(mThreadPoolMutex);
    if (!gMultithreadedDecoding || !mThreadPool) {
      NS_DispatchToMainThread(job);
    } else {
      mThreadPool->Dispatch(job, nsIEventTarget::DISPATCH_NORMAL);
    }
  }
}

void
RasterImage::DecodePool::DecodeABitOf(RasterImage* aImg)
{
  MOZ_ASSERT(NS_IsMainThread());
  aImg->mDecodingMutex.AssertCurrentThreadOwns();

  if (aImg->mDecodeRequest) {
    // If the image is waiting for decode work to be notified, go ahead and do that.
    if (aImg->mDecodeRequest->mRequestStatus == DecodeRequest::REQUEST_WORK_DONE) {
      aImg->FinishedSomeDecoding();
    }
  }

  DecodeSomeOfImage(aImg);

  aImg->FinishedSomeDecoding();

  // If the decoder needs a new frame, enqueue an event to get it; that event
  // will enqueue another decode request when it's done.
  if (aImg->mDecoder && aImg->mDecoder->NeedsNewFrame()) {
    FrameNeededWorker::GetNewFrame(aImg);
  } else {
    // If we aren't yet finished decoding and we have more data in hand, add
    // this request to the back of the priority list.
    if (aImg->mDecoder &&
        !aImg->mError &&
        !aImg->IsDecodeFinished() &&
        aImg->mSourceData.Length() > aImg->mBytesDecoded) {
      RequestDecode(aImg);
    }
  }
}

/* static */ void
RasterImage::DecodePool::StopDecoding(RasterImage* aImg)
{
  aImg->mDecodingMutex.AssertCurrentThreadOwns();

  // If we haven't got a decode request, we're not currently decoding. (Having
  // a decode request doesn't imply we *are* decoding, though.)
  if (aImg->mDecodeRequest) {
    aImg->mDecodeRequest->mRequestStatus = DecodeRequest::REQUEST_STOPPED;
  }
}

NS_IMETHODIMP
RasterImage::DecodePool::DecodeJob::Run()
{
  MutexAutoLock imglock(mImage->mDecodingMutex);

  // If we were interrupted, we shouldn't do any work.
  if (mRequest->mRequestStatus == DecodeRequest::REQUEST_STOPPED) {
    DecodeDoneWorker::NotifyFinishedSomeDecoding(mImage, mRequest);
    return NS_OK;
  }

  // If someone came along and synchronously decoded us, there's nothing for us to do.
  if (!mImage->mDecoder || mImage->IsDecodeFinished()) {
    DecodeDoneWorker::NotifyFinishedSomeDecoding(mImage, mRequest);
    return NS_OK;
  }

  // If we're a decode job that's been enqueued since a previous decode that
  // still needs a new frame, we can't do anything. Wait until the
  // FrameNeededWorker enqueues another frame.
  if (mImage->mDecoder->NeedsNewFrame()) {
    return NS_OK;
  }

  mRequest->mRequestStatus = DecodeRequest::REQUEST_ACTIVE;

  uint32_t oldByteCount = mImage->mBytesDecoded;

  DecodeType type = DECODE_TYPE_UNTIL_DONE_BYTES;

  // Multithreaded decoding can be disabled. If we've done so, we don't want to
  // monopolize the main thread, and will allow a timeout in DecodeSomeOfImage.
  if (NS_IsMainThread()) {
    type = DECODE_TYPE_UNTIL_TIME;
  }

  DecodePool::Singleton()->DecodeSomeOfImage(mImage, type, mRequest->mBytesToDecode);

  uint32_t bytesDecoded = mImage->mBytesDecoded - oldByteCount;

  mRequest->mRequestStatus = DecodeRequest::REQUEST_WORK_DONE;

  // If the decoder needs a new frame, enqueue an event to get it; that event
  // will enqueue another decode request when it's done.
  if (mImage->mDecoder && mImage->mDecoder->NeedsNewFrame()) {
    FrameNeededWorker::GetNewFrame(mImage);
  }
  // If we aren't yet finished decoding and we have more data in hand, add
  // this request to the back of the list.
  else if (mImage->mDecoder &&
           !mImage->mError &&
           !mImage->IsDecodeFinished() &&
           bytesDecoded < mRequest->mBytesToDecode &&
           bytesDecoded > 0) {
    DecodePool::Singleton()->RequestDecode(mImage);
  } else {
    // Nothing more for us to do - let everyone know what happened.
    DecodeDoneWorker::NotifyFinishedSomeDecoding(mImage, mRequest);
  }

  return NS_OK;
}

nsresult
RasterImage::DecodePool::DecodeUntilSizeAvailable(RasterImage* aImg)
{
  MOZ_ASSERT(NS_IsMainThread());

  MutexAutoLock imgLock(aImg->mDecodingMutex);

  if (aImg->mDecodeRequest) {
    // If the image is waiting for decode work to be notified, go ahead and do that.
    if (aImg->mDecodeRequest->mRequestStatus == DecodeRequest::REQUEST_WORK_DONE) {
      nsresult rv = aImg->FinishedSomeDecoding();
      if (NS_FAILED(rv)) {
        aImg->DoError();
        return rv;
      }
    }
  }

  nsresult rv = DecodeSomeOfImage(aImg, DECODE_TYPE_UNTIL_SIZE);
  if (NS_FAILED(rv)) {
    return rv;
  }

  // If the decoder needs a new frame, enqueue an event to get it; that event
  // will enqueue another decode request when it's done.
  if (aImg->mDecoder && aImg->mDecoder->NeedsNewFrame()) {
    FrameNeededWorker::GetNewFrame(aImg);
  } else {
    rv = aImg->FinishedSomeDecoding();
  }

  return rv;
}

nsresult
RasterImage::DecodePool::DecodeSomeOfImage(RasterImage* aImg,
                                           DecodeType aDecodeType /* = DECODE_TYPE_UNTIL_TIME */,
                                           uint32_t bytesToDecode /* = 0 */)
{
  NS_ABORT_IF_FALSE(aImg->mInitialized,
                    "Worker active for uninitialized container!");
  aImg->mDecodingMutex.AssertCurrentThreadOwns();

  // If an error is flagged, it probably happened while we were waiting
  // in the event queue.
  if (aImg->mError)
    return NS_OK;

  // If mDecoded or we don't have a decoder, we must have finished already (for
  // example, a synchronous decode request came while the worker was pending).
  if (!aImg->mDecoder || aImg->mDecoded)
    return NS_OK;

  // If we're doing synchronous decodes, and we're waiting on a new frame for
  // this image, get it now.
  if (aImg->mDecoder->IsSynchronous() && aImg->mDecoder->NeedsNewFrame()) {
    MOZ_ASSERT(NS_IsMainThread());

    aImg->mDecoder->AllocateFrame();
    aImg->mDecodeRequest->mAllocatedNewFrame = true;
  }

  // If we're not synchronous, we can't allocate a frame right now.
  else if (aImg->mDecoder->NeedsNewFrame()) {
    return NS_OK;
  }

  nsRefPtr<Decoder> decoderKungFuDeathGrip = aImg->mDecoder;

  uint32_t maxBytes;
  if (aImg->mDecoder->IsSizeDecode()) {
    // Decode all available data if we're a size decode; they're cheap, and we
    // want them to be more or less synchronous.
    maxBytes = aImg->mSourceData.Length();
  } else {
    // We're only guaranteed to decode this many bytes, so in particular,
    // gDecodeBytesAtATime should be set high enough for us to read the size
    // from most images.
    maxBytes = gDecodeBytesAtATime;
  }

  if (bytesToDecode == 0) {
    bytesToDecode = aImg->mSourceData.Length() - aImg->mBytesDecoded;
  }

  int32_t chunkCount = 0;
  TimeStamp start = TimeStamp::Now();
  TimeStamp deadline = start + TimeDuration::FromMilliseconds(gMaxMSBeforeYield);

  // We keep decoding chunks until:
  //  * we don't have any data left to decode,
  //  * the decode completes,
  //  * we're an UNTIL_SIZE decode and we get the size, or
  //  * we run out of time.
  // We also try to decode at least one "chunk" if we've allocated a new frame,
  // even if we have no more data to send to the decoder.
  while ((aImg->mSourceData.Length() > aImg->mBytesDecoded &&
          bytesToDecode > 0 &&
          !aImg->IsDecodeFinished() &&
          !(aDecodeType == DECODE_TYPE_UNTIL_SIZE && aImg->mHasSize) &&
          !aImg->mDecoder->NeedsNewFrame()) ||
         (aImg->mDecodeRequest && aImg->mDecodeRequest->mAllocatedNewFrame)) {
    chunkCount++;
    uint32_t chunkSize = std::min(bytesToDecode, maxBytes);
    nsresult rv = aImg->DecodeSomeData(chunkSize);
    if (NS_FAILED(rv)) {
      aImg->DoError();
      return rv;
    }

    bytesToDecode -= chunkSize;

    // Yield if we've been decoding for too long. We check this _after_ decoding
    // a chunk to ensure that we don't yield without doing any decoding.
    if (aDecodeType == DECODE_TYPE_UNTIL_TIME && TimeStamp::Now() >= deadline)
      break;
  }

  if (aImg->mDecodeRequest) {
    aImg->mDecodeRequest->mDecodeTime += (TimeStamp::Now() - start);
    aImg->mDecodeRequest->mChunkCount += chunkCount;
  }

  // Flush invalidations (and therefore paint) now that we've decoded all the
  // chunks we're going to.
  //
  // However, don't paint if:
  //
  //  * This was an until-size decode.  Until-size decodes are always followed
  //    by normal decodes, so don't bother painting.
  //
  //  * The decoder flagged an error.  The decoder may have written garbage
  //    into the output buffer; don't paint it to the screen.
  //
  //  * We have all the source data.  This disables progressive display of
  //    previously-decoded images, thus letting us finish decoding faster,
  //    since we don't waste time painting while we decode.
  //    Decoder::PostFrameStop() will flush invalidations once the decode is
  //    done.

  if (aDecodeType != DECODE_TYPE_UNTIL_SIZE &&
      !aImg->mDecoder->HasError() &&
      !aImg->mHasSourceData) {
    aImg->mInDecoder = true;
    aImg->mDecoder->FlushInvalidations();
    aImg->mInDecoder = false;
  }

  return NS_OK;
}

RasterImage::DecodeDoneWorker::DecodeDoneWorker(RasterImage* image, DecodeRequest* request)
 : mImage(image)
 , mRequest(request)
{}

void
RasterImage::DecodeDoneWorker::NotifyFinishedSomeDecoding(RasterImage* image, DecodeRequest* request)
{
  image->mDecodingMutex.AssertCurrentThreadOwns();

  nsCOMPtr<DecodeDoneWorker> worker = new DecodeDoneWorker(image, request);
  NS_DispatchToMainThread(worker);
}

NS_IMETHODIMP
RasterImage::DecodeDoneWorker::Run()
{
  MOZ_ASSERT(NS_IsMainThread());
  MutexAutoLock lock(mImage->mDecodingMutex);

  mImage->FinishedSomeDecoding(eShutdownIntent_Done, mRequest);

  return NS_OK;
}

RasterImage::FrameNeededWorker::FrameNeededWorker(RasterImage* image)
 : mImage(image)
{}


void
RasterImage::FrameNeededWorker::GetNewFrame(RasterImage* image)
{
  nsCOMPtr<FrameNeededWorker> worker = new FrameNeededWorker(image);
  NS_DispatchToMainThread(worker);
}

NS_IMETHODIMP
RasterImage::FrameNeededWorker::Run()
{
  MutexAutoLock lock(mImage->mDecodingMutex);
  nsresult rv = NS_OK;

  // If we got a synchronous decode in the mean time, we don't need to do
  // anything.
  if (mImage->mDecoder && mImage->mDecoder->NeedsNewFrame()) {
    rv = mImage->mDecoder->AllocateFrame();
    mImage->mDecodeRequest->mAllocatedNewFrame = true;
  }

  if (NS_SUCCEEDED(rv) && mImage->mDecoder) {
    // By definition, we're not done decoding, so enqueue us for more decoding.
    DecodePool::Singleton()->RequestDecode(mImage);
  }

  return NS_OK;
}

} // namespace image
} // namespace mozilla
