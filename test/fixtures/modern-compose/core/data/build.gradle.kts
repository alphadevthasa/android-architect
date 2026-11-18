plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ksp)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.example.modern.core.data"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
    }
}

dependencies {
    implementation(libs.room.runtime)
    ksp(libs.room.compiler)
    implementation(libs.retrofit)
    implementation(libs.kotlinx.serialization.json)
}
