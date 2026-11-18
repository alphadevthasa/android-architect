plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.example.modern.feature.home"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
    }
}

dependencies {
    implementation(project(":core:data"))
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.mockk)
    testImplementation(libs.turbine)
}
