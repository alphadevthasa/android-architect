plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.hub"
    compileSdk = 35
}

dependencies {
    implementation("com.example.core:core-net:1.4.0")
}
