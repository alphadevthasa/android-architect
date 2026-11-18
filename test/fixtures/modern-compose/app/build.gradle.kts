plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.example.modern"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.modern"
        minSdk = 24
        targetSdk = 35
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(projects.feature.home)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.coil.compose)
    implementation(libs.kotlinx.coroutines.android)
}
