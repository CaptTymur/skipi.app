# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# MainActivity methods are invoked from Rust over JNI (PDF rendering, file open,
# dispatch share). R8 can't see those call sites, so on a minified release build
# it strips them and the app crashes at runtime with NoSuchMethodError
# (e.g. renderSkipiPdfPage on demo/PDF load). Keep the whole class's members.
-keep class app.skipi.seafarer.MainActivity {
    public *;
}