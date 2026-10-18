#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <PDFKit/PDFKit.h>
#import <Vision/Vision.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) return 2;
        PDFDocument *document = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]]];
        NSInteger number = [[NSString stringWithUTF8String:argv[2]] integerValue];
        if (!document || number < 1 || number > document.pageCount) return 3;
        PDFPage *page = [document pageAtIndex:number - 1];
        NSRect bounds = [page boundsForBox:kPDFDisplayBoxMediaBox];
        if (bounds.size.width <= 0 || bounds.size.height <= 0) return 4;
        CGFloat scale = MIN(2.5, 2400.0 / MAX(bounds.size.width, bounds.size.height));
        NSImage *image = [page thumbnailOfSize:NSMakeSize(bounds.size.width * scale, bounds.size.height * scale) forBox:kPDFDisplayBoxMediaBox];
        CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
        if (!cg) return 5;
        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.recognitionLanguages = @[@"zh-Hans", @"en-US"];
        request.usesLanguageCorrection = YES;
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cg options:@{}];
        NSError *error = nil;
        if (![handler performRequests:@[request] error:&error]) return 6;
        for (VNRecognizedTextObservation *observation in request.results) {
            VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
            if (candidate.string) printf("%s\n", candidate.string.UTF8String);
        }
    }
    return 0;
}
