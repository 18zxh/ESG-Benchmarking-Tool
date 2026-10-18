#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <PDFKit/PDFKit.h>
#import <Vision/Vision.h>

static int fail(NSString *message) { fprintf(stderr, "%s", message.UTF8String); return 2; }
static NSArray *recognize(CGImageRef image, CGRect region, NSError **error) {
  VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = NO;
  request.minimumTextHeight = 0.0025;
  NSArray *supported = [request supportedRecognitionLanguagesAndReturnError:error];
  if (![supported containsObject:@"zh-Hans"]) return nil;
  request.recognitionLanguages = [supported containsObject:@"en-US"] ? @[@"zh-Hans", @"en-US"] : @[@"zh-Hans"];
  request.regionOfInterest = region;
  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
  if (![handler performRequests:@[request] error:error]) return nil;
  NSMutableArray *blocks = [NSMutableArray new];
  for (VNRecognizedTextObservation *item in request.results) {
    VNRecognizedText *candidate = [[item topCandidates:1] firstObject];
    if (!candidate.string.length) continue;
    CGRect box = item.boundingBox;
    // Vision returns ROI-relative coordinates; map cropped halves back to the page.
    box = CGRectMake(region.origin.x + box.origin.x*region.size.width,
      region.origin.y + box.origin.y*region.size.height,
      box.size.width*region.size.width, box.size.height*region.size.height);
    [blocks addObject:@{@"text":candidate.string, @"confidence":@(candidate.confidence),
      @"region":region.size.width < 1 ? (region.origin.x == 0 ? @"left" : @"right") : @"full",
      @"bbox":@[@(box.origin.x), @(1-box.origin.y-box.size.height), @(box.size.width), @(box.size.height)]}];
  }
  return blocks;
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) return fail(@"PDF 识别参数无效。");
    PDFDocument *doc = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:@(argv[1])]];
    if (!doc) return fail(@"PDF 已损坏或无法读取。");
    if (doc.isLocked) return fail(@"PDF 已加密，请先提供可读取的副本。");
    if (doc.pageCount < 1 || doc.pageCount > 500) return fail(@"PDF 页数须为 1–500 页。");
    NSMutableArray *pages = [NSMutableArray new];
    for (NSInteger index = 0; index < doc.pageCount; index++) {
      @autoreleasepool {
        PDFPage *page = [doc pageAtIndex:index];
        if (!page) return fail(@"PDF 页面无法读取。");
        NSString *native = page.string ?: @"";
        NSRect bounds = [page boundsForBox:kPDFDisplayBoxMediaBox];
        NSImage *render = [page thumbnailOfSize:NSMakeSize(4000,4000) forBox:kPDFDisplayBoxMediaBox];
        CGImageRef image = [render CGImageForProposedRect:NULL context:nil hints:nil];
        if (!image) return fail(@"PDF 页面无法渲染。");
        NSError *error = nil;
        NSArray *observations = recognize(image, CGRectMake(0,0,1,1), &error);
        if (!observations) return fail(@"本机简体中文 OCR 不可用。");
        NSMutableArray *ocr = [observations mutableCopy];
        if (bounds.size.width > bounds.size.height * 1.3) {
          NSArray *left = recognize(image, CGRectMake(0,0,0.5,1), &error);
          NSArray *right = recognize(image, CGRectMake(0.5,0,0.5,1), &error);
          if (left) [ocr addObjectsFromArray:left];
          if (right) [ocr addObjectsFromArray:right];
        }
        [ocr sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
          double y1=[a[@"bbox"][1] doubleValue], y2=[b[@"bbox"][1] doubleValue];
          if (fabs(y1-y2)>0.006) return y1<y2 ? NSOrderedAscending : NSOrderedDescending;
          double x1=[a[@"bbox"][0] doubleValue], x2=[b[@"bbox"][0] doubleValue];
          return x1<x2 ? NSOrderedAscending : x1>x2 ? NSOrderedDescending : NSOrderedSame;
        }];
        [pages addObject:@{@"page":@(index+1), @"nativeText":native,
          @"ocrBlocks":ocr, @"width":@(bounds.size.width), @"height":@(bounds.size.height)}];
        NSData *progress=[NSJSONSerialization dataWithJSONObject:@{@"completed":@(index+1), @"total":@(doc.pageCount), @"phase":@"文字与图像识别"} options:0 error:NULL];
        fwrite(progress.bytes,1,progress.length,stdout); fputc('\n',stdout); fflush(stdout);
      }
    }
    NSError *error=nil;
    NSData *result=[NSJSONSerialization dataWithJSONObject:@{@"pages":pages} options:NSJSONWritingSortedKeys error:&error];
    if (!result || ![result writeToFile:@(argv[2]) options:NSDataWritingAtomic error:&error]) return fail(@"无法生成识别结果。");
  }
  return 0;
}
