#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>

static NSArray<NSString *> *ImagePaths(NSString *directory) {
    NSFileManager *manager = NSFileManager.defaultManager;
    NSURL *root = [NSURL fileURLWithPath:directory];
    NSSet<NSString *> *extensions = [NSSet setWithArray:@[@"png", @"jpg", @"jpeg", @"gif"]];
    NSArray<NSURLResourceKey> *keys = @[NSURLIsRegularFileKey];
    NSDirectoryEnumerator<NSURL *> *enumerator = [manager enumeratorAtURL:root
                                              includingPropertiesForKeys:keys
                                                                 options:NSDirectoryEnumerationSkipsHiddenFiles
                                                            errorHandler:^BOOL(NSURL *url, NSError *error) {
        return YES;
    }];
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSURL *url in enumerator) {
        NSNumber *isRegular = nil;
        [url getResourceValue:&isRegular forKey:NSURLIsRegularFileKey error:nil];
        if (isRegular.boolValue && [extensions containsObject:url.pathExtension.lowercaseString]) {
            [paths addObject:url.path];
        }
    }
    return [paths sortedArrayUsingSelector:@selector(compare:)];
}

static NSArray<NSString *> *RecognizeText(NSString *path) {
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (source == NULL) return @[];
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    if (image == NULL) return @[];

    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.recognitionLanguages = @[@"zh-Hans", @"en-US"];
    request.usesLanguageCorrection = YES;
    request.minimumTextHeight = 0.012;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    NSError *error = nil;
    BOOL success = [handler performRequests:@[request] error:&error];
    CGImageRelease(image);
    if (!success) {
        fprintf(stderr, "ocr_error file=%s error=%s\n", path.lastPathComponent.UTF8String,
                error.localizedDescription.UTF8String ?: "unknown");
        return @[];
    }

    NSArray<VNRecognizedTextObservation *> *observations = [request.results sortedArrayUsingComparator:^NSComparisonResult(
        VNRecognizedTextObservation *left,
        VNRecognizedTextObservation *right
    ) {
        CGFloat verticalDifference = CGRectGetMaxY(left.boundingBox) - CGRectGetMaxY(right.boundingBox);
        if (fabs(verticalDifference) > 0.025) {
            return verticalDifference > 0 ? NSOrderedAscending : NSOrderedDescending;
        }
        CGFloat horizontalDifference = CGRectGetMinX(left.boundingBox) - CGRectGetMinX(right.boundingBox);
        if (fabs(horizontalDifference) < 0.001) return NSOrderedSame;
        return horizontalDifference < 0 ? NSOrderedAscending : NSOrderedDescending;
    }];
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in observations) {
        VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
        NSString *text = [candidate.string stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (text.length > 0 && candidate.confidence >= 0.35) [lines addObject:text];
    }
    return lines;
}

static void Fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) Fail(@"Usage: longtu-ocr <images-directory> <output-json>");
        NSString *imagesDirectory = [NSString stringWithUTF8String:argv[1]];
        NSString *outputPath = [NSString stringWithUTF8String:argv[2]];
        NSArray<NSString *> *paths = ImagePaths(imagesDirectory);
        NSMutableArray<NSDictionary *> *entries = [NSMutableArray arrayWithCapacity:paths.count];
        NSInteger processed = 0;
        for (NSString *path in paths) {
            @autoreleasepool {
                NSArray<NSString *> *lines = RecognizeText(path);
                [entries addObject:@{
                    @"filename": path.lastPathComponent,
                    @"lines": lines,
                }];
                processed += 1;
                if (processed % 25 == 0 || processed == paths.count) {
                    fprintf(stderr, "ocr=%ld/%lu\n", (long)processed, (unsigned long)paths.count);
                }
            }
        }
        NSDictionary *output = @{
            @"version": @1,
            @"generatedAt": [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]],
            @"entries": entries,
        };
        NSError *error = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:output options:NSJSONWritingPrettyPrinted error:&error];
        if (json == nil) Fail(error.localizedDescription);
        NSURL *outputURL = [NSURL fileURLWithPath:outputPath];
        [NSFileManager.defaultManager createDirectoryAtURL:outputURL.URLByDeletingLastPathComponent
                               withIntermediateDirectories:YES attributes:nil error:nil];
        if (![json writeToURL:outputURL options:NSDataWritingAtomic error:&error]) {
            Fail(error.localizedDescription);
        }
        printf("ocr=%lu output=%s\n", (unsigned long)entries.count, outputPath.UTF8String);
    }
    return 0;
}
