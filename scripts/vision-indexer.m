#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>
#import <stdatomic.h>

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

static VNFeaturePrintObservation *FeaturePrint(NSString *path) {
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (source == NULL) return nil;

    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    if (image == NULL) return nil;

    VNGenerateImageFeaturePrintRequest *request = [[VNGenerateImageFeaturePrintRequest alloc] init];
    request.revision = VNGenerateImageFeaturePrintRequestRevision2;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    NSError *error = nil;
    BOOL success = [handler performRequests:@[request] error:&error];
    CGImageRelease(image);
    if (!success || request.results.count == 0) {
        fprintf(stderr, "feature_error path=%s error=%s\n", path.UTF8String, error.localizedDescription.UTF8String ?: "unknown");
        return nil;
    }
    return (VNFeaturePrintObservation *)request.results.firstObject;
}

static void Fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 5) {
            Fail(@"Usage: vision-indexer <references-directory> <source-directory> <output-json> <top-count>");
        }

        NSString *referencesDirectory = [NSString stringWithUTF8String:argv[1]];
        NSString *sourceDirectory = [NSString stringWithUTF8String:argv[2]];
        NSString *outputPath = [NSString stringWithUTF8String:argv[3]];
        NSInteger topCount = MAX(1, [[NSString stringWithUTF8String:argv[4]] integerValue]);

        NSArray<NSString *> *referencePaths = ImagePaths(referencesDirectory);
        if (referencePaths.count == 0) Fail(@"No reference images found");

        NSMutableArray<VNFeaturePrintObservation *> *referencePrints = [NSMutableArray array];
        NSMutableArray<NSString *> *usableReferencePaths = [NSMutableArray array];
        for (NSString *path in referencePaths) {
            VNFeaturePrintObservation *print = FeaturePrint(path);
            if (print != nil) {
                [referencePrints addObject:print];
                [usableReferencePaths addObject:path];
            }
        }
        if (referencePrints.count == 0) Fail(@"Unable to extract reference features");

        for (NSInteger left = 0; left < referencePrints.count; left++) {
            for (NSInteger right = left + 1; right < referencePrints.count; right++) {
                float distance = 0;
                NSError *error = nil;
                if ([referencePrints[left] computeDistance:&distance toFeaturePrintObservation:referencePrints[right] error:&error]) {
                    fprintf(stderr, "reference_distance[%ld,%ld]=%.6f\n", (long)left + 1, (long)right + 1, distance);
                }
            }
        }

        NSArray<NSString *> *candidates = ImagePaths(sourceDirectory);
        NSMutableArray<NSDictionary *> *results = [NSMutableArray arrayWithCapacity:candidates.count];
        __block atomic_int completed = 0;
        __block atomic_int failed = 0;

        dispatch_apply(candidates.count, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t index) {
            @autoreleasepool {
                NSString *candidatePath = candidates[index];
                VNFeaturePrintObservation *candidatePrint = FeaturePrint(candidatePath);
                if (candidatePrint == nil) {
                    atomic_fetch_add(&failed, 1);
                } else {
                    float minimumDistance = FLT_MAX;
                    for (VNFeaturePrintObservation *referencePrint in referencePrints) {
                        float distance = 0;
                        NSError *error = nil;
                        if ([candidatePrint computeDistance:&distance toFeaturePrintObservation:referencePrint error:&error]) {
                            minimumDistance = MIN(minimumDistance, distance);
                        }
                    }
                    if (isfinite(minimumDistance)) {
                        NSDictionary *entry = @{@"path": candidatePath, @"score": @(minimumDistance)};
                        @synchronized (results) {
                            [results addObject:entry];
                        }
                    }
                }

                int current = atomic_fetch_add(&completed, 1) + 1;
                if (current % 250 == 0 || current == candidates.count) {
                    fprintf(stderr, "indexed=%d/%lu\n", current, (unsigned long)candidates.count);
                }
            }
        });

        [results sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
            return [left[@"score"] compare:right[@"score"]];
        }];
        if (results.count > topCount) {
            [results removeObjectsInRange:NSMakeRange(topCount, results.count - topCount)];
        }

        NSDictionary *output = @{
            @"version": @3,
            @"algorithm": @"apple-vision-feature-print-v2",
            @"generatedAt": [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]],
            @"referencePaths": usableReferencePaths,
            @"scannedCount": @(candidates.count),
            @"failedCount": @(atomic_load(&failed)),
            @"entries": results,
        };

        NSError *jsonError = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:output options:NSJSONWritingPrettyPrinted error:&jsonError];
        if (json == nil) Fail(jsonError.localizedDescription);

        NSURL *outputURL = [NSURL fileURLWithPath:outputPath];
        [NSFileManager.defaultManager createDirectoryAtURL:outputURL.URLByDeletingLastPathComponent
                               withIntermediateDirectories:YES
                                                attributes:nil
                                                     error:nil];
        if (![json writeToURL:outputURL options:NSDataWritingAtomic error:&jsonError]) {
            Fail(jsonError.localizedDescription);
        }

        printf("scanned=%lu failed=%d indexed=%lu output=%s\n",
               (unsigned long)candidates.count,
               atomic_load(&failed),
               (unsigned long)results.count,
               outputPath.UTF8String);
    }
    return 0;
}
