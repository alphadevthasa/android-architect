plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.featureapp"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.featureapp"
        minSdk = 24
        targetSdk = 35
    }
}

dependencies {
    implementation(project(":feature:login"))
    implementation(project(":feature:payment"))
    implementation(project(":feature:profile"))
    implementation(project(":feature:legacy-reports"))
}
