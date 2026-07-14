#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <PDFKit/PDFKit.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>

static void Fail(NSString *message) {
  fprintf(stderr, "Continuum native ingestion failed: %s\n", message.UTF8String);
  exit(2);
}

static void Emit(id value) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (!data || error) Fail(@"result serialization failed");
  [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
}

static CGImageRef CreateImage(NSData *data) {
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
  if (!source) return NULL;
  CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
  CFRelease(source);
  return image;
}

static CGImageRef RenderPdfPage(NSData *data, NSInteger pageNumber) {
  PDFDocument *document = [[PDFDocument alloc] initWithData:data];
  if (!document || pageNumber < 1 || pageNumber > document.pageCount) return NULL;
  PDFPage *page = [document pageAtIndex:(NSUInteger)(pageNumber - 1)];
  if (!page) return NULL;
  NSRect bounds = [page boundsForBox:kPDFDisplayBoxMediaBox];
  CGFloat maxDimension = 4096.0;
  CGFloat scale = MIN(2.0, maxDimension / MAX(MAX(bounds.size.width, bounds.size.height), 1.0));
  size_t width = MAX(1, (size_t)ceil(bounds.size.width * scale));
  size_t height = MAX(1, (size_t)ceil(bounds.size.height * scale));
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, 0, colorSpace, kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(colorSpace);
  if (!context) return NULL;
  CGContextSetRGBFillColor(context, 1, 1, 1, 1);
  CGContextFillRect(context, CGRectMake(0, 0, width, height));
  CGContextSaveGState(context);
  CGContextScaleCTM(context, scale, scale);
  CGContextTranslateCTM(context, -bounds.origin.x, -bounds.origin.y);
  [page drawWithBox:kPDFDisplayBoxMediaBox toContext:context];
  CGContextRestoreGState(context);
  CGImageRef image = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  return image;
}

static NSDictionary *Recognize(CGImageRef image, NSNumber *pageNumber) {
  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = YES;
  request.minimumTextHeight = 0.006;
  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
  NSError *error = nil;
  if (![handler performRequests:@[request] error:&error]) Fail(error.localizedDescription ?: @"Apple Vision request failed");
  NSArray<VNRecognizedTextObservation *> *observations = [request.results sortedArrayUsingComparator:^NSComparisonResult(VNRecognizedTextObservation *left, VNRecognizedTextObservation *right) {
    CGFloat delta = CGRectGetMaxY(left.boundingBox) - CGRectGetMaxY(right.boundingBox);
    if (fabs(delta) > 0.01) return delta > 0 ? NSOrderedAscending : NSOrderedDescending;
    if (CGRectGetMinX(left.boundingBox) < CGRectGetMinX(right.boundingBox)) return NSOrderedAscending;
    if (CGRectGetMinX(left.boundingBox) > CGRectGetMinX(right.boundingBox)) return NSOrderedDescending;
    return NSOrderedSame;
  }];
  NSMutableArray<NSString *> *lines = [NSMutableArray array];
  NSMutableArray<NSDictionary *> *words = [NSMutableArray array];
  for (VNRecognizedTextObservation *observation in observations) {
    VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
    if (!candidate) continue;
    [lines addObject:candidate.string];
    CGRect box = observation.boundingBox;
    NSMutableDictionary *word = [@{
      @"text": candidate.string,
      @"confidence": @(candidate.confidence),
      @"x": @(CGRectGetMinX(box)),
      @"y": @(CGRectGetMinY(box)),
      @"width": @(CGRectGetWidth(box)),
      @"height": @(CGRectGetHeight(box))
    } mutableCopy];
    if (pageNumber) word[@"page"] = pageNumber;
    [words addObject:word];
  }
  NSOperatingSystemVersion version = NSProcessInfo.processInfo.operatingSystemVersion;
  return @{
    @"text": [lines componentsJoinedByString:@"\n"],
    @"words": words,
    @"engine": @"Apple Vision",
    @"engineVersion": [NSString stringWithFormat:@"macOS %ld.%ld.%ld", (long)version.majorVersion, (long)version.minorVersion, (long)version.patchVersion]
  };
}

static NSArray<NSDictionary *> *TextItems(PDFPage *page, NSString *text) {
  NSMutableArray<NSDictionary *> *items = [NSMutableArray array];
  NSUInteger searchStart = 0;
  for (NSString *rawLine in [text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
    NSString *line = [rawLine stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (line.length == 0 || searchStart >= text.length) continue;
    NSRange range = [text rangeOfString:rawLine options:0 range:NSMakeRange(searchStart, text.length - searchStart)];
    if (range.location == NSNotFound) continue;
    searchStart = NSMaxRange(range);
    PDFSelection *selection = [page selectionForRange:range];
    if (!selection) continue;
    NSRect bounds = [selection boundsForPage:page];
    [items addObject:@{
      @"text": line,
      @"x": @(bounds.origin.x),
      @"y": @(bounds.origin.y),
      @"width": @(bounds.size.width),
      @"height": @(bounds.size.height)
    }];
  }
  return items;
}

static NSArray<NSDictionary *> *ExtractPdf(NSData *data) {
  PDFDocument *document = [[PDFDocument alloc] initWithData:data];
  if (!document) Fail(@"PDFKit could not open the document");
  NSMutableArray<NSDictionary *> *pages = [NSMutableArray array];
  for (NSUInteger index = 0; index < document.pageCount; index += 1) {
    PDFPage *page = [document pageAtIndex:index];
    if (!page) continue;
    NSString *text = page.string ?: @"";
    [pages addObject:@{
      @"page": @(index + 1),
      @"text": text,
      @"items": TextItems(page, text)
    }];
  }
  return pages;
}

static NSDictionary *ProviderThumbnail(NSData *data) {
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
  if (!source) Fail(@"image could not be decoded");
  NSDictionary *options = @{
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @1024
  };
  CGImageRef thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
  CFRelease(source);
  if (!thumbnail) Fail(@"image thumbnail could not be created");
  NSMutableData *output = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)output, CFSTR("public.jpeg"), 1, NULL);
  if (!destination) {
    CGImageRelease(thumbnail);
    Fail(@"image thumbnail encoder is unavailable");
  }
  NSDictionary *properties = @{ (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.72 };
  CGImageDestinationAddImage(destination, thumbnail, (__bridge CFDictionaryRef)properties);
  BOOL finalized = CGImageDestinationFinalize(destination);
  size_t width = CGImageGetWidth(thumbnail);
  size_t height = CGImageGetHeight(thumbnail);
  CFRelease(destination);
  CGImageRelease(thumbnail);
  if (!finalized || output.length == 0 || output.length > 2 * 1024 * 1024) Fail(@"image thumbnail exceeded its provider safety limit");
  return @{
    @"mediaType": @"image/jpeg",
    @"base64": [output base64EncodedStringWithOptions:0],
    @"width": @(width),
    @"height": @(height)
  };
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 4) Fail(@"invalid arguments");
    NSString *mode = [NSString stringWithUTF8String:argv[1]];
    NSString *path = [NSString stringWithUTF8String:argv[2]];
    NSString *mediaType = [NSString stringWithUTF8String:argv[3]];
    NSData *data = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:nil];
    if (!data) Fail(@"input could not be read");
    if ([mode isEqualToString:@"pdf"]) {
      Emit(ExtractPdf(data));
      return 0;
    }
    if ([mode isEqualToString:@"thumbnail"]) {
      Emit(ProviderThumbnail(data));
      return 0;
    }
    if (![mode isEqualToString:@"ocr"]) Fail(@"unknown mode");
    NSInteger page = argc >= 5 ? [[NSString stringWithUTF8String:argv[4]] integerValue] : 0;
    CGImageRef image = [mediaType isEqualToString:@"application/pdf"] ? RenderPdfPage(data, MAX(page, 1)) : CreateImage(data);
    if (!image) Fail(@"image or PDF page could not be decoded");
    Emit(Recognize(image, page > 0 ? @(page) : nil));
    CGImageRelease(image);
    return 0;
  }
}
